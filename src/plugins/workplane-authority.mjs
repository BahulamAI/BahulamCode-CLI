/**
 * Host-side Workplane authority for a plugin.
 *
 * PRD-108 section 6.3 "local service" mode: the CLI owns the document and
 * serializes commands, so an agent and a browser view commit through the same
 * gateway rather than each keeping their own copy.
 *
 * Storage is the plugin's own SQLite sidecar, through the narrow
 * `state.workplane` surface: a document snapshot plus an APPEND-ONLY event log,
 * written in one transaction. A unique index on (document_id, revision) means
 * a second writer's revision N is refused by the database rather than noticed
 * afterwards — the structural half of what content-addressed commits detect.
 *
 * Without node:sqlite (Node < 22) the same surface falls back to a single JSON
 * value with bounded history. `state.workplane.historyComplete()` reports which
 * is in effect, so a caller verifying a commit chain can tell "not all here"
 * from "broken".
 */
import { LocalAuthority, createDocument } from '@bahulam/workplane-ui';

/** StoragePort over the plugin's Workplane tables. */
class PluginWorkplaneStorage {
  #state;
  #seed;

  constructor(state, seed) {
    this.#state = state;
    this.#seed = seed;
  }

  async load(documentId) {
    return this.#state.workplane.loadDocument(documentId) ?? this.#seed;
  }

  async commit(bundle) {
    this.#state.workplane.commit(bundle.document.id, bundle);
  }

  async receipt(documentId, commandId) {
    return this.#state.workplane.receipt(documentId, commandId);
  }

  async eventsAfter(documentId, revision) {
    return this.#state.workplane.eventsAfter(documentId, revision);
  }

  /** Full append-only history, oldest first. */
  async history(documentId, options) {
    return this.#state.workplane.history(documentId, options);
  }

  /** False when running on the bounded JSON fallback. */
  historyComplete() {
    return this.#state.workplane.historyComplete();
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
    // Carried on the policy so every caller — panel, agent, HTTP — reads the
    // same registered list rather than assembling its own.
    actions: workplane?.actions ?? [],
  };

  const storage = new PluginWorkplaneStorage(state, seed);

  return {
    documentId,
    policy,
    storage,
    authority: new LocalAuthority({ storage, policy }),
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
