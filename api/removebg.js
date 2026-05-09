export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const FormData = (await import('form-data')).default;
  const fetch = (await import('node-fetch')).default;

  const base64 = req.body.image; // base64 string
  const buffer = Buffer.from(base64, 'base64');

  const form = new FormData();
  form.append('image_file', buffer, { filename: 'image.png', contentType: 'image/png' });
  form.append('size', 'auto');

  const response = await fetch('https://api.remove.bg/v1.0/removebg', {
    method: 'POST',
    headers: { 'X-Api-Key': process.env.REMOVEBG_API_KEY },
    body: form,
  });

  if (!response.ok) {
    const err = await response.json();
    return res.status(response.status).json({ error: err });
  }

  const arrayBuffer = await response.arrayBuffer();
  const resultBase64 = Buffer.from(arrayBuffer).toString('base64');
  res.json({ image: resultBase64 });
}
