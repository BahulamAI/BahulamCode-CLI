use crate::model::{safe_text, InteractionOption, Model};
pub fn options(model: &Model, focused_card: usize) -> Vec<InteractionOption> {
    let mut options = vec![InteractionOption {
        label: "Latest response".into(),
        value: "last".into(),
    }];
    if model.cards.get(focused_card).is_some() {
        options.push(InteractionOption {
            label: "Selected card".into(),
            value: format!("card:{focused_card}"),
        });
    }
    for (card_index, card) in model.cards.iter().enumerate() {
        let content = card.detail.as_deref().unwrap_or(&card.body);
        for (block_index, (language, _)) in fenced_code_blocks(content).iter().enumerate() {
            let language = if language.is_empty() {
                String::new()
            } else {
                format!(" · {language}")
            };
            options.push(InteractionOption {
                label: format!(
                    "Code block {} · {}{}",
                    block_index + 1,
                    safe_text(&card.title),
                    language
                ),
                value: format!("code:{card_index}:{block_index}"),
            });
        }
        if matches!(card.tool_name.as_str(), "bash" | "shell") && !card.primary.trim().is_empty() {
            options.push(InteractionOption {
                label: format!(
                    "Command · {}",
                    safe_text(&card.primary)
                        .chars()
                        .take(56)
                        .collect::<String>()
                ),
                value: format!("command:{card_index}"),
            });
        }
        if card.title.eq_ignore_ascii_case("diff") && !content.trim().is_empty() {
            let path = if card.primary.is_empty() {
                String::new()
            } else {
                format!(" · {}", safe_text(&card.primary))
            };
            options.push(InteractionOption {
                label: format!("Diff{path}"),
                value: format!("diff:{card_index}"),
            });
        }
    }
    options.push(InteractionOption {
        label: "Full transcript".into(),
        value: "transcript".into(),
    });
    options
}

pub fn selection_text(model: &Model, selection: &str, focused_card: usize) -> Option<String> {
    let selected_content = |index: usize| {
        model
            .cards
            .get(index)
            .map(|item| item.detail.as_deref().unwrap_or(&item.body))
    };
    match selection {
        "last" => model
            .cards
            .iter()
            .rev()
            .find(|card| card.title == "Assistant" && !card.body.is_empty())
            .map(|card| card.detail.as_deref().unwrap_or(&card.body).to_owned()),
        "card" => selected_content(focused_card).map(str::to_owned),
        "code" => selected_content(focused_card).and_then(first_fenced_code_block),
        "transcript" => Some(
            model
                .cards
                .iter()
                .map(|card| {
                    format!(
                        "{}\n{}",
                        card.title,
                        card.detail.as_deref().unwrap_or(&card.body)
                    )
                })
                .collect::<Vec<_>>()
                .join("\n\n"),
        ),
        value if value.starts_with("card:") => value
            .strip_prefix("card:")
            .and_then(|index| index.parse().ok())
            .and_then(selected_content)
            .map(str::to_owned),
        value if value.starts_with("command:") => value
            .strip_prefix("command:")
            .and_then(|index| index.parse::<usize>().ok())
            .and_then(|index| model.cards.get(index))
            .map(|card| card.primary.clone()),
        value if value.starts_with("diff:") => value
            .strip_prefix("diff:")
            .and_then(|index| index.parse().ok())
            .and_then(selected_content)
            .map(str::to_owned),
        value if value.starts_with("code:") => {
            let mut parts = value.split(':');
            let _ = parts.next();
            let card_index = parts.next()?.parse::<usize>().ok()?;
            let block_index = parts.next()?.parse::<usize>().ok()?;
            let card = model.cards.get(card_index)?;
            let content = card.detail.as_deref().unwrap_or(&card.body);
            fenced_code_blocks(content)
                .get(block_index)
                .map(|(_, code)| code.clone())
        }
        _ => None,
    }
}

fn first_fenced_code_block(text: &str) -> Option<String> {
    fenced_code_blocks(text)
        .into_iter()
        .next()
        .map(|(_, code)| code)
}

fn fenced_code_blocks(text: &str) -> Vec<(String, String)> {
    let mut offset = 0;
    let mut opening: Option<(char, usize, usize, String)> = None;
    let mut blocks = Vec::new();
    for line in text.split_inclusive('\n') {
        let without_newline = line.strip_suffix('\n').unwrap_or(line);
        let trimmed = without_newline.trim_start_matches(' ');
        let indent = without_newline.len().saturating_sub(trimmed.len());
        if indent <= 3 {
            let fence = trimmed
                .chars()
                .take_while(|ch| matches!(ch, '`' | '~'))
                .count();
            if fence >= 3 {
                let marker = trimmed.chars().next().unwrap_or('`');
                if let Some((open_marker, open_len, content_start, language)) = opening.take() {
                    let closing = marker == open_marker
                        && fence >= open_len
                        && trimmed[fence..].trim().is_empty();
                    if closing {
                        blocks.push((language, text[content_start..offset].to_owned()));
                    } else {
                        opening = Some((open_marker, open_len, content_start, language));
                    }
                } else if marker == '~' || !trimmed[fence..].contains('`') {
                    let language = trimmed[fence..]
                        .split_whitespace()
                        .next()
                        .unwrap_or_default()
                        .to_owned();
                    opening = Some((marker, fence, offset + line.len(), language));
                }
            }
        }
        offset += line.len();
    }
    blocks
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn copy_code_preserves_text_and_supports_longer_and_tilde_fences() {
        let text = "intro\n````rust\nlet x = `literal`;\n```\n````\n~~~py\nprint('界')\n~~~\n";
        let blocks = fenced_code_blocks(text);
        assert_eq!(
            blocks,
            vec![
                ("rust".into(), "let x = `literal`;\n```\n".into()),
                ("py".into(), "print('界')\n".into())
            ]
        );
    }
}
