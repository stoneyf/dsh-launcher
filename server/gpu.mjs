/**
 * GPU 检测：nvidia-smi 查询型号/总显存/空闲显存/驱动版本。
 * 无 NVIDIA 显卡或 nvidia-smi 不可用时返回 { available: false }。
 */
import { run } from './core.mjs'
import { join } from 'node:path'

let cached = null
let cachedAt = 0
const CACHE_MS = 10000

export async function gpuInfo(force = false) {
  if (!force && cached && Date.now() - cachedAt < CACHE_MS) return cached
  const nvidiaSmi = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'nvidia-smi.exe')
  const result = run(nvidiaSmi, ['--query-gpu=name,memory.total,memory.free,driver_version', '--format=csv,noheader,nounits'])
  if (!result.ok) {
    cached = { available: false, vendor: null, error: (result.stderr || '').trim().slice(0, 200) }
    cachedAt = Date.now()
    return cached
  }
  const line = result.stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean) ?? ''
  const [name, totalMiB, freeMiB, driver] = line.split(',').map(s => (s ?? '').trim())
  cached = {
    available: true,
    vendor: 'nvidia',
    name,
    driver,
    totalMiB: Number(totalMiB) || null,
    freeMiB: Number(freeMiB) || null,
    usedMiB: (Number(totalMiB) || 0) - (Number(freeMiB) || 0),
  }
  cachedAt = Date.now()
  return cached
}
