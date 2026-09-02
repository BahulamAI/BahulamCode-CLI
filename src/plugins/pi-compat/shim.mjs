/**
 * Pi runtime shim — the synthetic `pi` module a composed pi package
 * imports at load time.
 *
 * Pi's extension API is imperative: extensions do `import { pi } from
 * 'pi'` and call `pi.registerTool(name, schema, handler)` /
 * `pi.registerCommand(cmd, handler)` / `pi.ctx.ui.setWidget(...)`. We
 * intercept the module resolution via a Node ESM loader hook
 * (`loader-hook.mjs`) that returns a virtual module which imports THIS
 * shim and instantiates it against a shared capture object.
 *
 * v1 scope:
 *   - registerTool: captured, exposed to our loop as a pluginToolMap entry
 *   - registerCommand: captured but not surfaced (no REPL command bridge)
 *   - pi.events.on/emit: no-op (cross-extension event bus, deferred)
 *   - pi.ctx.ui.setWidget/custom: no-op with debug warning (TUI widgets
 *     don't translate to our workspace canvas; author dedicated panels)
 *   - pi.ctx.log: forwards to stderr with plugin prefix
 */

export function createPiShim({ pluginName = 'pi', captured }) {
  if (!captured || typeof captured !== 'object') {
    throw new Error('createPiShim: captured object is required');
  }
  captured.tools ||= [];
  captured.commands ||= [];

  const pi = {
    // Pi's canonical shape is registerTool({name, description, parameters,
    // execute}) — a single descriptor with an `execute` function. Older
    // examples use registerTool(name, schema, handler) with positional args.
    // Accept both.
    registerTool(arg1, arg2, arg3) {
      if (arg1 && typeof arg1 === 'object' && !Array.isArray(arg1)) {
        const desc = arg1;
        const name = desc.name;
        if (!name || typeof name !== 'string') return;
        // Descriptor form: pi's canonical `{name, description, parameters,
        // execute}`. Handler is called as execute(id, params).
        captured.tools.push({
          name,
          description: desc.description || '',
          schema: desc.parameters || desc.input_schema || desc.schema || { type: 'object', properties: {} },
          handler: typeof desc.execute === 'function' ? desc.execute
                 : typeof desc.handler === 'function' ? desc.handler
                 : typeof desc.call === 'function' ? desc.call
                 : null,
          _form: 'descriptor',
        });
        return;
      }
      // Positional legacy form: (name, schema, handler). Handler is
      // called as handler(args).
      if (!arg1 || typeof arg1 !== 'string') return;
      let name = arg1, schema = arg2, handler = arg3;
      if (typeof handler !== 'function' && typeof schema === 'function') {
        handler = schema;
        schema = { type: 'object', properties: {} };
      }
      captured.tools.push({
        name,
        description: '',
        schema: schema || { type: 'object', properties: {} },
        handler,
        _form: 'positional',
      });
    },

    // registerCommand(cmd, descriptor) in real pi; descriptor has
    // {description, execute}. Older form: registerCommand(cmd, handler).
    registerCommand(cmd, arg2) {
      if (!cmd || typeof cmd !== 'string') return;
      if (arg2 && typeof arg2 === 'object' && !Array.isArray(arg2)) {
        const desc = arg2;
        captured.commands.push({
          cmd,
          description: desc.description || '',
          handler: typeof desc.execute === 'function' ? desc.execute
                 : typeof desc.handler === 'function' ? desc.handler
                 : null,
        });
      } else if (typeof arg2 === 'function') {
        captured.commands.push({ cmd, handler: arg2 });
      }
    },

    events: {
      on() { /* no-op in v1 */ },
      emit() { /* no-op in v1 */ },
      off() { /* no-op in v1 */ },
    },

    // Pi packages call pi.on(...) directly for lifecycle events (session
    // start/end etc.) — no-op them so activation reaches registerTool.
    // Same treatment for pi.off, pi.emit, pi.once.
    on() { /* no-op */ },
    off() { /* no-op */ },
    emit() { /* no-op */ },
    once() { /* no-op */ },

    // Additional pi surfaces called at activation-time by real packages
    // (pi-web-access, etc.). Stub them so activation completes and tools
    // register; runtime callers that rely on these still throw at call
    // time, which is the correct signal that a feature isn't supported.
    registerShortcut() { /* no-op */ },
    appendEntry() { /* no-op */ },
    sendMessage() { /* no-op */ },
    exec() {
      throw new Error(`[pi:${pluginName}] pi.exec is not supported in Bahulam compat`);
    },
    // pi.fetch is pi's authenticated fetch. Delegate to global fetch —
    // that's what the extension expects: an HTTP client. Auth headers
    // are typically added by the extension itself using env credentials.
    fetch(...args) { return globalThis.fetch(...args); },

    ctx: {
      ui: {
        setWidget(widget) {
          if (process.env.DEBUG) {
            const title = widget?.title || widget?.name || 'untitled';
            process.stderr.write(`[pi:${pluginName}] widget ignored: ${title}\n`);
          }
        },
        custom() { /* no-op */ },
        clear() { /* no-op */ },
      },
      log(...args) {
        process.stderr.write(`[pi:${pluginName}] ${args.map(String).join(' ')}\n`);
      },
    },
  };

  // Pi's ExtensionAPI is a moving target — packages call methods we haven't
  // stubbed yet (registerMessageRenderer, registerRoute, registerHandler,
  // …). Any unstubbed method call throws, aborting activation before
  // registerTool ever runs, and the probe reports 0 tools.
  //
  // Fall back to a no-op returner for every unknown property so activation
  // reaches its full extent. A tool's runtime call may still fail if it
  // needed that surface — that's an accurate signal at execution time,
  // not a silent black hole at load time.
  return new Proxy(pi, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver);
      if (typeof prop === 'symbol') return undefined;
      if (process.env.DEBUG) {
        process.stderr.write(`[pi:${pluginName}] shim: pi.${String(prop)} stubbed (no-op)\n`);
      }
      // Return a callable that also has method access (e.g. pi.foo.bar).
      // Property access on the stub returns another stub, so chains never
      // throw. Result is undefined so anything that reads a return value
      // treats it as "not present" (typeof result === 'undefined').
      const stub = function stub() { return undefined; };
      return new Proxy(stub, {
        get(t, p) {
          if (typeof p === 'symbol') return t[p];
          return stub;
        },
      });
    },
  });
}
