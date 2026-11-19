// Vercel serverless endpoint. Set ANTHROPIC_API_KEY in Vercel Environment Variables.
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  const { messages = [], memory = [] } = req.body || {};
  if (!Array.isArray(messages) || messages.length > 20 || !Array.isArray(memory)) {
    return res.status(400).json({ error: 'Некоректний запит' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'Чат ще не налаштовано: додай ANTHROPIC_API_KEY у Vercel → Settings → Environment Variables.' });
  }
  const system = 'Ти — «Зошит», ШІ-помічник студента. Відповідай мовою користувача (зазвичай українською), по суті й структуровано. ' +
    'Коли потрібні свіжі факти, книги чи джерела — шукай в інтернеті й давай посилання. Твори, реферати, конспекти пиши якісно, без води, ' +
    'у стилі й за вимогами, які студент уже задавав. Файли й фото розбирай уважно.' +
    (memory.length ? '\n\nПопередні запити студента (для послідовності):\n- ' + memory.slice(-20).join('\n- ') : '');
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: process.env.MODEL || 'claude-sonnet-4-5', max_tokens: 4000, system, messages, tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }] })
    });
    const d = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: d.error?.message || 'Помилка API' });
    res.json({ text: (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('') });
  } catch (e) { res.status(500).json({ error: 'Помилка сервера' }); }
};