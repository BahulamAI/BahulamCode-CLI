/**
 * Host-side Workplane authority for a plugin.
 *
 * PRD-108 section 6.3 "local service" mode: the CLI owns the document and
 * serializes commands, so an agent and a browser view commit through the same
 * gateway rather than each keeping their own copy.
 *
 * The storage format is byte-compatible with the browser adapter's
 * `PluginStateStorage` — one JSON value under the `workplane_document` key
 * holding `{ document, events, receipts }`. That compatibility is the point: a
 * panel and an agent must see one document, not two that happen to look alike.
 */
import { LocalAuthority, createDocument } from '@bahulam/workplane-ui';

const DOCUMENT_KEY = 'workplane_document';
const MAX_EVENTS = 500;

/** StoragePort over a plugin's shared-blackboard KV. */
class PluginKvStorage {
  #state;
  #seed;

  constructor(state, seed) {
    this.#state = state;
    this.#seed = seed;
  }

  #read() {
    const raw = this.#state.get(DOCUMENT_KEY, null);
    if (raw && typeof raw === 'object' && raw.document?.id) {
      return {
        document: raw.document,
        events: Array.isArray(raw.events) ? raw.events : [],
        receipts: raw.receipts && typeof raw.receipts === 'object' ? raw.receipts : {},
      };
    }
    return { document: this.#seed, events: [], receipts: {} };
  }

  async load(documentId) {
    const persisted = this.#read();
    return persisted.document.id === documentId ? persisted.document : undefined;
  }

  async commit(bundle) {
    const persisted = this.#read();
    const events = [...persisted.events, bundle.event];
    // Document, event and receipt land in ONE `set`, so a crash cannot leave an
    // acknowledged change with no durable record.
    this.#state.set(DOCUMENT_KEY, {
      document: bundle.document,
      events: events.length > MAX_EVENTS ? events.slice(-MAX_EVENTS) : events,
      receipts: { ...persisted.receipts, [bundle.receipt.commandId]: bundle.receipt },
    });
  }

  async receipt(_documentId, commandId) {
    return this.#read().receipts[commandId];
  }

  async eventsAfter(_documentId, revision) {
    return this.#read().events.filter((event) => event.revision > revision);
  }
}

export function workplaneDocumentId(pluginName, workplane) {
  return workplane?.document?.id || `wp_${String(pluginName).replace(/[^A-Za-z0-9_.:-]/g, '_')}`;
}

/**
 * Build the authority for one plugin.
 *
 * Not cached: the state proxy is created per call by the caller, and holding a
 * stale one would read a stale document. The authority itself is cheap.
 */
export function createWorkplaneAuthority(pluginName, { state, workplane }) {
  const documentId = workplaneDocumentId(pluginName, workplane);
  const seed = createDocument({
    id: documentId,
    title: workplane?.document?.title || `${pluginName} workplane`,
  });

  const policy = {
    // Agents and users alike need this to add or move blocks. It is granted to
    // the plugin's own agent below; a future read-only actor simply lacks it.
    structuralCapability: 'workplane.edit',
    writablePaths: workplane?.writablePaths ?? [],
  };

  return {
    documentId,
    policy,
    authority: new LocalAuthority({ storage: new PluginKvStorage(state, seed), policy }),
  };
}

/**
 * The acting agent. Capabilities are assigned HERE, by the host, from the
 * plugin's own manifest — never read from anything the model produced.
 */
export function agentActor(pluginName) {
  return {
    id: `agent:${pluginName}`,
    type: 'agent',
    label: `${pluginName} agent`,
    capabilities: ['workplane.edit'],
  };
}
