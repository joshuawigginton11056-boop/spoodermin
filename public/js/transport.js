// Networked transport: talk to the real match server over a WebSocket.
//
// The offline single-file build swaps this module for `transport-local.js`,
// which runs the same match server in-page. Everything downstream of here is
// identical either way.

import { Net } from './net.js';

export const MULTIPLAYER = true;

export function createTransport() {
  return new Net();
}
