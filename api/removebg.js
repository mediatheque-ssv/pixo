export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { image } = req.body;
    if (!image) return res.status(400).json({ error: 'Champ "image" manquant.' });

    const buffer = Buffer.from(image, 'base64');

    const formData = new FormData();
    formData.append('size', 'auto');
    formData.append(
      'image_file',
      new Blob([buffer], { type: 'image/png' }),
      'image.png'
    );

    const response = await fetch('https://api.remove.bg/v1.0/removebg', {
      method: 'POST',
      headers: { 'X-Api-Key': process.env.REMOVEBG_API_KEY },
      body: formData,
    });

    if (!response.ok) {
      let errMsg = `Erreur remove.bg : ${response.status}`;
      try {
        const errData = await response.json();
        if (errData?.errors?.[0]?.title) errMsg = errData.errors[0].title;
      } catch (_) {}
      return res.status(response.status).json({ error: errMsg });
    }

    const arrayBuffer = await response.arrayBuffer();
    const resultBase64 = Buffer.from(arrayBuffer).toString('base64');
    res.status(200).json({ image: resultBase64 });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Erreur serveur.' });
  }
}
