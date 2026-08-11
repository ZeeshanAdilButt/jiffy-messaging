import type { WebSocket } from 'ws'

/** Tracks open sockets per user id. A user can hold more than one - one per tab or device. */
export class ConnectionRegistry {
  private readonly connections = new Map<string, Set<WebSocket>>()

  add(userId: string, socket: WebSocket): void {
    let sockets = this.connections.get(userId)
    if (!sockets) {
      sockets = new Set()
      this.connections.set(userId, sockets)
    }
    sockets.add(socket)
  }

  remove(userId: string, socket: WebSocket): void {
    const sockets = this.connections.get(userId)
    if (!sockets) return

    sockets.delete(socket)
    if (sockets.size === 0) {
      this.connections.delete(userId)
    }
  }

  get(userId: string): ReadonlySet<WebSocket> {
    return this.connections.get(userId) ?? new Set()
  }
}
