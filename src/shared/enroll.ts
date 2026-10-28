/**
 * 供给端一键引导串（enroll）：自包含云端地址与注册密钥。
 * 格式：rce_<base64url(json{c:云端地址, k:供给凭证 token})>
 * 管理员在控制台创建供给凭证时生成，交付给用户；用户克隆仓库后：
 *   npx tsx src/provider/index.ts --enroll <串>
 * 供给端解码后自动写入 provider.config.json 并连接。
 */

export interface EnrollPayload {
  /** 云端控制台地址（由引导串携带，仓库中不含真实地址） */
  c: string;
  /** 供给凭证 token（rpk_ 前缀） */
  k: string;
}

export function encodeEnroll(payload: EnrollPayload): string {
  const json = JSON.stringify(payload);
  const b64 = Buffer.from(json, 'utf8').toString('base64url');
  return `rce_${b64}`;
}

export function decodeEnroll(enroll: string): EnrollPayload | null {
  const trimmed = enroll.trim();
  if (!trimmed.startsWith('rce_')) return null;
  try {
    const json = Buffer.from(trimmed.slice(4), 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as Partial<EnrollPayload>;
    if (typeof parsed.c !== 'string' || typeof parsed.k !== 'string') return null;
    return { c: parsed.c, k: parsed.k };
  } catch {
    return null;
  }
}

/** 由云端地址推导供给端 WS 地址 */
export function consoleUrlFromBase(base: string): string {
  const ws = base.trim().replace(/\/$/, '').replace(/^http/, 'ws');
  return `${ws}/ws/server`;
}
