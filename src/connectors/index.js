import { DiscordConnector } from './discord.js';

const connectors = {
  discord: DiscordConnector,
};

export function createConnector(name, options) {
  const Connector = connectors[name];
  if (!Connector) {
    throw new Error(`모르는 커넥터 '${name}'. 지금 있는 건: ${Object.keys(connectors).join(', ')}`);
  }
  return new Connector(options);
}

export const connectorNames = Object.keys(connectors);
