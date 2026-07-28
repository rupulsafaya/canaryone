// A tiny agent module that calls OpenAI via raw fetch (no SDK).
// canaryone's methodology check should classify this repo as no-sdk-detected
// and refuse to advance to task picking.

export async function ask(prompt) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${process.env.OPENAI_API_KEY ?? ''}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const body = await res.json();
  return body.choices?.[0]?.message?.content ?? '';
}
