// SPDX-License-Identifier: MPL-2.0
export class ChannelPresence {
  private readonly active = new Map<number, Map<number, number>>()
  constructor(private readonly ttlMs = 75_000, private readonly clock = () => Date.now()) {}

  heartbeat(channelId: number, userId: number, allowed?: (userId: number) => boolean): number {
    const members = this.active.get(channelId) || new Map<number, number>()
    members.set(userId, this.clock())
    this.active.set(channelId, members)
    return this.count(channelId, allowed)
  }

  leave(channelId: number, userId: number): void {
    const members = this.active.get(channelId)
    members?.delete(userId)
    if (!members?.size) this.active.delete(channelId)
  }

  leaveAll(userId: number): void {
    for (const channelId of this.active.keys()) this.leave(channelId, userId)
  }

  clear(channelId: number): void { this.active.delete(channelId) }

  count(channelId: number, allowed?: (userId: number) => boolean): number {
    const members = this.active.get(channelId)
    if (!members) return 0
    const cutoff = this.clock() - this.ttlMs
    for (const [userId, seen] of members) if (seen <= cutoff || (allowed && !allowed(userId))) members.delete(userId)
    if (!members.size) this.active.delete(channelId)
    return members.size
  }
}
