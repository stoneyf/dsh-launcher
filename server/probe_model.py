#!/usr/bin/env python
"""探测 gguf 模型文件，输出 JSON：{architecture, native_context, kv_per_token, max_output}。

- native_context: 模型原生上下文长度（arch.context_length），缺省为 null。
- kv_per_token:   每个 token 的 KV 缓存字节数（f16），只算全注意力层。
                  用于按显存反推可容纳的上下文长度。
- max_output:     模型本身能生成的最大输出 token（"模型上限"）。gguf 里通常没有
                  这个字段，按架构名 + 文件名做映射（见 MAX_OUTPUT_RULES），
                  匹配不到用 DEFAULT_MAX_OUTPUT。用于"自动"模式下算最大输出。
依赖 gguf-py（pip install gguf）；缺失或解析失败时输出全 null（max_output 除外），
调用方走兜底。
用法: python probe_model.py <model.gguf>
"""
import os
import re
import sys
import json


def _norm(s) -> str:
    """去掉非字母数字、转小写，方便跨命名匹配（llama-3.1 → llama31）。"""
    return re.sub(r"[^a-z0-9]", "", str(s).lower())


# 架构/文件名 → 模型最大输出 token。按子串匹配，从上到下优先（更具体的在前）。
# 值是"模型能生成的上限"，不是上下文长度。匹配不到用 DEFAULT_MAX_OUTPUT。
MAX_OUTPUT_RULES = [
    ("qwen3", 65536),      # Qwen3 / Qwen3.5 / Qwen3.8 → 64K（官网 Max Output Length=65536）
    ("qwen2.5", 8192),     # Qwen2.5 → 8K
    ("qwen2", 8192),       # Qwen2 → 8K
    ("llama3.1", 8192),    # Llama 3.1 → 8K
    ("llama3", 4096),      # Llama 3 → 4K
    ("llama2", 4096),      # Llama 2 → 4K
    ("llama", 4096),       # Llama（其他版本）→ 4K
    ("mistral", 8192),     # Mistral → 8K
    ("gemma2", 8192),      # Gemma 2 → 8K
    ("gemma", 8192),       # Gemma → 8K
    ("phi4", 16384),       # Phi-4 → 16K
    ("phi3", 8192),        # Phi-3 → 8K
    ("deepseek", 8192),    # DeepSeek → 8K
]
DEFAULT_MAX_OUTPUT = 32768


def _max_output(arch, path) -> int:
    key = _norm(arch or "") + _norm(os.path.basename(path or ""))
    for pattern, val in MAX_OUTPUT_RULES:
        if _norm(pattern) in key:
            return val
    return DEFAULT_MAX_OUTPUT


def main() -> None:
    out = {"architecture": None, "native_context": None, "kv_per_token": None,
           "max_output": DEFAULT_MAX_OUTPUT}
    if len(sys.argv) < 2:
        print(json.dumps(out))
        return
    model = sys.argv[1]
    try:
        import gguf
    except Exception:
        out["max_output"] = _max_output(None, model)
        print(json.dumps(out))
        return
    try:
        g = gguf.GGUFReader(model)
    except Exception:
        out["max_output"] = _max_output(None, model)
        print(json.dumps(out))
        return

    def get(key):
        try:
            return g.fields[key].contents()
        except Exception:
            return None

    arch = None
    for k in g.fields:
        if k.endswith(".architecture"):
            arch = get(k)
            break
    out["architecture"] = arch
    out["max_output"] = _max_output(arch, model)
    if arch:
        out["native_context"] = get(f"{arch}.context_length")
        block_count = get(f"{arch}.block_count")
        interval = get(f"{arch}.full_attention_interval") or 1
        kv_heads = get(f"{arch}.attention.head_count_kv")
        key_len = get(f"{arch}.attention.key_length")
        if block_count and kv_heads and key_len:
            # 全注意力层数（向上取整，略保守 → 少分配上下文更稳）
            n_full = -(-block_count // interval)
            # K+V、f16(2 字节)
            out["kv_per_token"] = n_full * 2 * kv_heads * key_len * 2
    print(json.dumps(out))


if __name__ == "__main__":
    main()
