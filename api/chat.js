// Pollinations BYOP proxy. The short-lived user-authorized token is never stored here.
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Увійди та підключи ШІ, щоб почати чат.' });

  const { messages = [], memory = [] } = req.body || {};
  if (!Array.isArray(messages) || messages.length > 20 || !Array.isArray(memory)) {
    return res.status(400).json({ error: 'Некоректний запит' });
  }

  const system = 'Ти — «Зошит», ШІ-помічник студента. Відповідай мовою користувача (зазвичай українською), по суті й структуровано. ' +
    'Коли потрібні свіжі факти, книги чи джерела — шукай в інтернеті й давай посилання, якщо доступний пошук. ' +
    'Твори, реферати, конспекти пиши якісно, без води, враховуй вимоги студента. Файли й фото розбирай уважно.' +
    (memory.length ? '\n\nПопередні запити студента для контексту:\n- ' + memory.slice(-20).map(x => String(x).slice(0, 300)).join('\n- ') : '');

  const converted = messages.slice(-18).map(m => {
    let content = m.content;
    if (Array.isArray(content)) {
      content = content.map(p => {
        if (p.type === 'text') return { type: 'text', text: String(p.text || '').slice(0, 30000) };
        if (p.type === 'image' && p.source?.type === 'base64') {
          return { type: 'image_url', image_url: { url: 'data:' + p.source.media_type + ';base64,' + p.source.data } };
        }
        if (p.type === 'document') return { type: 'text', text: '[PDF додано, але читання PDF напряму поки не підтримується. Надішли фото сторінок або скопійований текст.]' };
        return { type: 'text', text: '' };
      });
    }
    return { role: m.role === 'assistant' ? 'assistant' : 'user', content };
  });

  try {
    const r = await fetch('https://gen.pollinations.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({
        model: 'openai/gpt-5.4-nano',
        messages: [{ role: 'system', content: system }, ...converted],
        max_tokens: 3000
      })
    });
    const d = await r.json();
    if (!r.ok) return res.status(r.status).json({
      error: r.status === 402
        ? 'На акаунті ШІ закінчився доступний баланс. Перевір витрати в Pollinations.'
        : (d.error?.message || d.message || 'Помилка сервісу ШІ')
    });
    const answer = d.choices?.[0]?.message?.content;
    const text = Array.isArray(answer) ? answer.map(x => x.text || '').join('') : (answer || '');
    return res.json({ text: text || 'Модель не повернула текстову відповідь.' });
  } catch {
    return res.status(502).json({ error: 'Не вдалося зв’язатися із сервісом ШІ. Спробуй ще раз.' });
  }
};
