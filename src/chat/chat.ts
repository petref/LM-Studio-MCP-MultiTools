import 'dotenv/config';
import { fetch } from 'undici';

const API_BASE = process.env.LMSTUDIO_API_BASE || 'http://localhost:1234/v1';
const API_KEY  = process.env.LMSTUDIO_API_KEY || 'lm-studio';
const MODEL    = process.env.LMSTUDIO_MODEL   || 'qwen2.5-coder:7b-instruct';
const TIMEOUT  = Number(process.env.REQUEST_TIMEOUT_MS || '60000');

async function main() {
  const userText = process.argv.slice(2).join(' ').trim() || 'Say hello.';
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), TIMEOUT);

  try {
    const res = await fetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: userText }],
        stream: true
      }),
      signal: controller.signal
    });

    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status} – ${await res.text()}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    process.stdout.write('\n> ' + userText + '\n\n');

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';
      for (const p of parts) {
        if (p.startsWith('data: ')) {
          const json = p.slice(6);
          if (json === '[DONE]') break;
          try {
            const evt = JSON.parse(json);
            const token = evt.choices?.[0]?.delta?.content ?? '';
            if (token) process.stdout.write(token);
          } catch {
            // ignore parse errors/keep-alives
          }
        }
      }
    }
    process.stdout.write('\n\n');
  } finally {
    clearTimeout(id);
  }
}

main().catch(err => {
  console.error('Chat error:', err);
  process.exit(1);
});

