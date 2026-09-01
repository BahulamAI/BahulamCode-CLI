/**
 * CLI Argument Parser — supports all major Claude Code flags.
 *
 * Flags:
 * --model, -m          Model to use
 * --permission-mode    Permission mode
 * --print, -p          Print mode (non-interactive prompt)
 * --output-format      json, text, stream-json
 * --system-prompt      Override system prompt
 * --add-dir            Additional CLAUDE.md directories
 * --max-turns          Maximum conversation turns
 * --allowedTools       Comma-separated allowed tools
 * --disallowedTools    Comma-separated denied tools
 * --verbose, -v        Verbose output
 * --debug, -d          Debug mode
 * --version            Show version
 * --help, -h           Show help
 */

export function parseArgs(args) {
    const result = {
        prompt: null,
        model: null,
        permissionMode: null,
        outputFormat: null,
        systemPrompt: null,
        addDirs: [],
        maxTurns: null,
        timeout: null,
        allowedTools: null,
        disallowedTools: null,
        route: null,
        resume: false,
        resumeSessionId: null,
        headless: false,
        skipPermissions: false,
        vision: [],
        verbose: false,
        debug: false,
        showVersion: false,
        showHelp: false,
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        switch (arg) {
            case '--model':
            case '-m':
                result.model = args[++i];
                break;

            case '--route':
                result.route = args[++i];
                break;

            case '--permission-mode':
                result.permissionMode = args[++i];
                break;

            case '--print':
            case '-p':
                result.prompt = args[++i];
                break;

            case '--output-format':
                result.outputFormat = args[++i];
                break;

            case '--system-prompt':
                result.systemPrompt = args[++i];
                break;

            case '--add-dir':
                result.addDirs.push(args[++i]);
                break;

            case '--max-turns':
                result.maxTurns = parseInt(args[++i], 10);
                break;

            case '--timeout':
                result.timeout = parseInt(args[++i], 10);
                break;

            case '--allowedTools':
                result.allowedTools = args[++i]?.split(',').map(s => s.trim());
                break;

            case '--disallowedTools':
                result.disallowedTools = args[++i]?.split(',').map(s => s.trim());
                break;

            case '--resume':
            case '--continue':
            case '-r': {
                result.resume = true;
                // Optional: --resume <sessionId>
                const next = args[i + 1];
                if (next && !next.startsWith('-')) {
                    result.resumeSessionId = next;
                    i++;
                }
                break;
            }

            case '--headless':
                result.headless = true;
                result.skipPermissions = true; // headless implies skip permissions
                break;

            case '--agent':
                result.agent = args[++i];
                break;

            case '--workflow':
                result.workflow = args[++i];
                break;

            case '--cache-report':
                // PRD-071 §1.5 — write a machine-readable cache summary to
                // <path> at end of run. Consumed by benchmark/cache-check.sh.
                result.cacheReport = args[++i];
                break;

            case '--local':
                // Force LocalAgent path (bypass backend). Meant for benchmarks
                // that need to exercise the CLI's own LLM code — cache_control
                // wiring, prompt-cache stats, etc.
                result.local = true;
                break;

            case '--vision': {
                const value = args[++i];
                if (value) result.vision.push(value);
                break;
            }

            case '--dangerously-skip-permissions':
                result.skipPermissions = true;
                break;

            case '--verbose':
            case '-v':
                result.verbose = true;
                break;

            case '--debug':
            case '-d':
                result.debug = true;
                break;

            case '--version':
                result.showVersion = true;
                break;

            case '--help':
            case '-h':
                result.showHelp = true;
                break;

            default:
                // Bare argument becomes prompt
                if (!arg.startsWith('-')) {
                    result.prompt = arg;
                }
                break;
        }
    }

    return result;
}

/**
 * Print usage/help text.
 * @returns {string}
 */
export function getUsageText() {
    return `
Usage: occ [options] [prompt]

Options:
  --model, -m <id|role=id>   Session model override (also named modes: fast|thinking|extra|max)
  --route <platform|byok>    Model route; platform validates against the curated catalog
  --permission-mode <mode>   Permission mode (bypassPermissions, acceptEdits, plan, auto, dontAsk)
  --print, -p <prompt>       Non-interactive mode: run prompt and exit
  --output-format <fmt>      Output format: text, json, stream-json
  --system-prompt <text>     Override system prompt
  --add-dir <dir>            Additional directory to search for CLAUDE.md
  --max-turns <n>            Maximum conversation turns
  --allowedTools <tools>     Comma-separated list of allowed tools
  --disallowedTools <tools>  Comma-separated list of denied tools
  --resume, -r [sessionId]   Resume last session (or specific session)
  --continue                 Alias for --resume
  --headless                 Non-interactive mode: auto-approve, JSONL output
  --cache-report <file>      Write prompt-cache summary JSON to <file> (headless only)
  --vision <image-path>      Attach image path in headless mode
  --dangerously-skip-permissions  Skip ALL approval prompts, including dangerous tiers
  --verbose, -v              Verbose output
  --debug, -d                Debug mode
  --version                  Show version
  --help, -h                 Show this help

Examples:
  occ                        Start interactive REPL
  occ -p "What is 2+2?"     Run prompt and exit
  occ -m claude-haiku-4-5    Use Haiku model
  occ --debug -p "Fix bug"  Debug mode with prompt
`.trim();
}
