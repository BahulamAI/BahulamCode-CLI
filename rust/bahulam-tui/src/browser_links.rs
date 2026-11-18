//! Browser targets are presentation data. Keep source messages/copy text intact.
use crate::{
    model::{Card, Interaction, InteractionOption},
    open_target::LinkTarget,
};
use std::collections::HashSet;

pub fn valid_url(value: &str) -> bool {
    if value.len() > 2048
        || value.chars().any(|c| {
            c.is_whitespace() || c.is_control() || matches!(c, '\\' | '"' | '<' | '>' | '`')
        })
    {
        return false;
    }
    let Some(rest) = value
        .strip_prefix("https://")
        .or_else(|| value.strip_prefix("http://"))
    else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    !authority.is_empty()
        && !authority.contains('@')
        && authority.chars().any(|c| c.is_alphanumeric())
}

pub fn extract(text: &str) -> Vec<LinkTarget> {
    let mut links = Vec::new();
    let mut seen = HashSet::new();
    for (start, _) in text.match_indices("http") {
        if links.len() >= 32 {
            break;
        }
        let tail = &text[start..];
        if !tail.starts_with("http://") && !tail.starts_with("https://") {
            continue;
        }
        let mut parens = 0usize;
        let mut brackets = 0usize;
        let end = tail
            .char_indices()
            .find_map(|(index, c)| {
                if c.is_whitespace() || matches!(c, '<' | '>' | '"' | '\'' | '`') {
                    return Some(index);
                }
                match c {
                    '(' => parens += 1,
                    ')' if parens == 0 => return Some(index),
                    ')' => parens -= 1,
                    '[' => brackets += 1,
                    ']' if brackets == 0 => return Some(index),
                    ']' => brackets -= 1,
                    _ => {}
                }
                None
            })
            .unwrap_or(tail.len());
        let uri = tail[..end].trim_end_matches([',', '.', ';', '!', '?']);
        if !valid_url(uri) || !seen.insert(uri.to_owned()) {
            continue;
        }
        let prefix = &text[..start];
        let label = prefix
            .strip_suffix("](")
            .and_then(|p| p.rsplit_once('[').map(|(_, label)| label))
            .filter(|label| !label.is_empty() && !label.contains(['\n', '\r']))
            .map(|label| label.chars().take(80).collect())
            .unwrap_or_else(|| uri.to_owned());
        links.push(LinkTarget {
            label,
            uri: uri.to_owned(),
        });
    }
    links
}

pub fn for_card(card: &Card) -> Vec<LinkTarget> {
    let mut links = extract(card.detail.as_deref().unwrap_or(&card.body));
    if let Some(uri) = card.open_url.as_ref().filter(|uri| valid_url(uri)) {
        if !links.iter().any(|link| link.uri == *uri) {
            links.insert(
                0,
                LinkTarget {
                    label: card.title.clone(),
                    uri: uri.clone(),
                },
            );
            links.truncate(32);
        }
    }
    links
}

pub fn picker(links: Vec<LinkTarget>) -> Interaction {
    Interaction {
        request_id: "local-browser-links".into(),
        title: "Open a browser link".into(),
        message: "Choose a destination · Enter open · Esc return".into(),
        options: links
            .into_iter()
            .map(|link| InteractionOption {
                label: if link.label == link.uri {
                    link.uri.clone()
                } else {
                    format!("{} · {}", link.label, link.uri)
                },
                value: link.uri,
            })
            .collect(),
        selected: 0,
        allow_free_text: false,
        editing: false,
        free_text: String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn multiple_urls_keep_labels_balanced_paths_and_query_arguments() {
        let links = extract("[Docs](https://example.test/wiki_(page)) and https://other.test/a?x=1&y=2. Again https://other.test/a?x=1&y=2.");
        assert_eq!(
            extract("[a](https://a.test)[b](https://b.test)")
                .iter()
                .map(|link| link.uri.as_str())
                .collect::<Vec<_>>(),
            vec!["https://a.test", "https://b.test"]
        );
        assert_eq!(links.len(), 2);
        assert_eq!(links[0].label, "Docs");
        assert_eq!(links[0].uri, "https://example.test/wiki_(page)");
        assert_eq!(links[1].uri, "https://other.test/a?x=1&y=2");
    }
    #[test]
    fn unsafe_or_non_browser_targets_are_not_actions() {
        for value in [
            "javascript:alert(1)",
            "file:///tmp/a",
            "https://",
            "https://user:pass@example.test",
            "https://example.test/\x1b]52;evil",
            "https://example.test/a\nb",
            "https://example.test/\\evil",
        ] {
            assert!(!valid_url(value), "{value:?}");
        }
        assert!(valid_url("http://localhost:8080/a#part"));
        assert!(valid_url("http://[::1]:8080/a"));
        assert_eq!(
            extract(
                &(0..100)
                    .map(|n| format!("https://example.test/{n} "))
                    .collect::<String>()
            )
            .len(),
            32
        );
    }
}
