import net from 'node:net';
import type { CloudCommand, ServerMessage } from '../shared/protocol.js';

/**
 * 内网穿透（供给端侧）：把云端经 L1 WebSocket 下发的隧道字节流
 * 桥接到本机 TCP 目标（sshd）。SSH 协议自身端到端加密，本桥接不解析内容。
 *
 * 生命周期：tunnel-open → 建连 → 双向 tunnel-data → 任一侧断开 → tunnel-close。
 */
export class TunnelBridge {
  private readonly sockets = new Map<string, net.Socket>();

  constructor(private readonly send: (msg: ServerMessage) => void) {}

  handleCommand(cmd: CloudCommand): void {
    switch (cmd.type) {
      case 'tunnel-open':
        this.open(cmd.tunnelId, cmd.targetPort);
        break;
      case 'tunnel-data': {
        const sock = this.sockets.get(cmd.tunnelId);
        if (sock && !sock.destroyed) sock.write(Buffer.from(cmd.payload, 'base64'));
        break;
      }
      case 'tunnel-close':
        this.close(cmd.tunnelId, cmd.reason);
        break;
    }
  }

  private open(tunnelId: string, targetPort: number): void {
    if (this.sockets.has(tunnelId)) return;
    const sock = net.connect({ host: '127.0.0.1', port: targetPort }, () => {
      console.log(`[tunnel] ${tunnelId} → 127.0.0.1:${targetPort} 已建立`);
    });
    this.sockets.set(tunnelId, sock);
    sock.on('data', (buf: Buffer) => {
      this.send({ type: 'tunnel-data', tunnelId, payload: buf.toString('base64') });
    });
    sock.on('error', () => undefined);
    sock.on('close', () => {
      if (this.sockets.get(tunnelId) === sock) {
        this.sockets.delete(tunnelId);
        this.send({ type: 'tunnel-close', tunnelId, reason: 'target-closed' });
      }
    });
  }

  private close(tunnelId: string, reason?: string): void {
    const sock = this.sockets.get(tunnelId);
    if (sock) {
      this.sockets.delete(tunnelId);
      sock.destroy();
      console.log(`[tunnel] ${tunnelId} 已关闭（${reason ?? 'cloud'}）`);
    }
  }

  closeAll(reason = 'shutdown'): void {
    for (const id of [...this.sockets.keys()]) this.close(id, reason);
  }
}
