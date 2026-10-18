import { App } from '@microsoft/teams.apps';
import { startTeamsServer } from '../../src/connectors/microsoft-teams/server.mjs';

await startTeamsServer({ App });
