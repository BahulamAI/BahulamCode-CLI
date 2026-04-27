import { TopBar } from '@/components/layout/top-bar'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

const CLI_COMMANDS = [
  { cmd: 'orca', desc: 'Start interactive REPL' },
  { cmd: 'orca "instruction"', desc: 'Run a single instruction and exit' },
  { cmd: 'orca dashboard', desc: 'Open Orca Pulse analytics dashboard' },
  { cmd: 'orca sessions', desc: 'List recent local sessions' },
  { cmd: 'orca stats', desc: 'Show aggregate local session stats' },
  { cmd: 'orca history', desc: 'Show recent prompt history' },
  { cmd: 'orca login', desc: 'Sign in via browser' },
  { cmd: 'orca version', desc: 'Show version' },
]

const REPL_COMMANDS = [
  { cmd: '/help', desc: 'Show available commands' },
  { cmd: '/stats', desc: 'Session metrics — tokens, cost, tools' },
  { cmd: '/cost', desc: 'Detailed cost breakdown by model' },
  { cmd: '/history', desc: 'Conversation history' },
  { cmd: '/clear', desc: 'Clear conversation history' },
  { cmd: '/safety', desc: 'Show safety guardrail status' },
  { cmd: '/revoke', desc: 'Revoke auto-approvals' },
  { cmd: '/explore <query>', desc: 'Spawn read-only codebase explorer' },
  { cmd: '/review <query>', desc: 'Spawn code review agent' },
  { cmd: '/architect <query>', desc: 'Spawn architecture planning agent' },
  { cmd: '/exit', desc: 'Exit the REPL' },
]

const KEYBOARD = [
  { key: 'Esc', desc: 'Cancel current execution' },
  { key: 'Space', desc: 'Pause / resume execution' },
  { key: 'Ctrl+C', desc: 'Exit' },
  { key: 'Tab', desc: 'Autocomplete slash commands' },
  { key: 'Up/Down', desc: 'Navigate input history' },
]

const ENV_VARS = [
  { name: 'TARANG_ENV', desc: 'Set backend environment (local, development, production)' },
  { name: 'ANTHROPIC_API_KEY', desc: 'Direct Anthropic API key for local mode' },
  { name: 'OPENROUTER_API_KEY', desc: 'OpenRouter API key' },
  { name: 'ORCA_CONFIG_DIR', desc: 'Override config directory (default: ~/.orca)' },
  { name: 'TARANG_BACKEND_URL', desc: 'Override backend URL explicitly' },
]

const FEATURES = [
  { title: 'Multi-Agent Orchestration', desc: 'Primary agent spawns explore, plan, and review sub-agents for complex tasks.' },
  { title: 'Smart Tool Routing', desc: 'Write operations routed to CLI for local execution. Read tools run server-side.' },
  { title: 'Safety Guardrails', desc: 'Destructive commands (rm, delete) always require approval. Path validation on all file operations.' },
  { title: 'Local JSONL Analytics', desc: 'Every session is recorded to ~/.orca/ for offline analytics via Orca Pulse.' },
  { title: 'Conversation History', desc: 'Multi-turn conversations within a REPL session. Context preserved across turns.' },
  { title: 'BM25 Code Index', desc: 'Project files indexed on startup for fast semantic code search.' },
]

function CommandTable({ commands }: { commands: { cmd: string; desc: string }[] }) {
  return (
    <div className="space-y-1">
      {commands.map(({ cmd, desc }) => (
        <div key={cmd} className="flex items-start gap-4 py-1.5">
          <code className="text-sm font-mono text-primary whitespace-nowrap shrink-0 min-w-[200px]">{cmd}</code>
          <span className="text-sm text-muted-foreground">{desc}</span>
        </div>
      ))}
    </div>
  )
}

export default function HelpPage() {
  return (
    <div className="flex flex-col min-h-screen">
      <TopBar title="Help" subtitle="Orca CLI commands, shortcuts, and configuration" />
      <div className="px-6 py-6 space-y-6">

        <Card>
          <CardHeader>
            <CardTitle>CLI Commands</CardTitle>
          </CardHeader>
          <CardContent>
            <CommandTable commands={CLI_COMMANDS} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>REPL Commands</CardTitle>
          </CardHeader>
          <CardContent>
            <CommandTable commands={REPL_COMMANDS} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Keyboard Shortcuts</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              {KEYBOARD.map(({ key, desc }) => (
                <div key={key} className="flex items-start gap-4 py-1.5">
                  <kbd className="text-sm font-mono bg-muted px-2 py-0.5 rounded border border-border whitespace-nowrap shrink-0 min-w-[100px] text-center">{key}</kbd>
                  <span className="text-sm text-muted-foreground">{desc}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Environment Variables</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              {ENV_VARS.map(({ name, desc }) => (
                <div key={name} className="flex items-start gap-4 py-1.5">
                  <code className="text-sm font-mono text-primary whitespace-nowrap shrink-0 min-w-[200px]">{name}</code>
                  <span className="text-sm text-muted-foreground">{desc}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Features</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {FEATURES.map(({ title, desc }) => (
                <div key={title} className="space-y-1">
                  <h4 className="text-sm font-semibold">{title}</h4>
                  <p className="text-sm text-muted-foreground">{desc}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

      </div>
    </div>
  )
}
