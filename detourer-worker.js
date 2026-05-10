// detourer-worker.js
// Mettre ce fichier au même endroit que detourer.html dans le repo GitHub.
// Tourne dans un thread séparé : charge BiRefNet lite et fait l'inférence.

import { AutoModel, AutoProcessor, RawImage }
  from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.4.2';

const MODEL_ID = 'onnx-community/BiRefNet_lite';
let model = null, processor = null;

// Charger le modèle dès le démarrage du worker
// On essaie fp16 d'abord (moitié moins de RAM que fp32),
// puis q8 en fallback si fp16 échoue aussi.
(async () => {
  const dtypes = ['fp16', 'q8'];
  let lastErr = null;
  for (const dtype of dtypes) {
    try {
      [model, processor] = await Promise.all([
        AutoModel.from_pretrained(MODEL_ID, { dtype }),
        AutoProcessor.from_pretrained(MODEL_ID),
      ]);
      self.postMessage({ type: 'ready', dtype });
      return;
    } catch (e) {
      console.warn(`BiRefNet lite dtype=${dtype} échoué:`, e.message ?? e);
      lastErr = e;
    }
  }
  self.postMessage({ type: 'error', msg: 'Chargement modèle : ' + (lastErr?.message ?? lastErr) });
})();

self.onmessage = async (ev) => {
  if (ev.data.type !== 'segment') return;

  try {
    // L'image arrive comme ArrayBuffer (zero-copy via transferable)
    const blob    = new Blob([ev.data.buffer], { type: ev.data.mime });
    const blobUrl = URL.createObjectURL(blob);
    const image   = await RawImage.fromURL(blobUrl);
    URL.revokeObjectURL(blobUrl);

    // Pré-traitement + inférence
    const { pixel_values } = await processor(image);
    const output = await model({ input_image: pixel_values });

    // Récupérer le tenseur de sortie (clé variable selon la version)
    const outTensor = output.output_image
      ?? output.logits
      ?? Object.values(output)[0];
    if (!outTensor) throw new Error('Aucune sortie valide du modèle');

    // sigmoid → uint8 → redimensionner à la taille originale
    const maskImg = await RawImage.fromTensor(
      (outTensor[0] ?? outTensor).sigmoid().mul(255).to('uint8')
    ).resize(image.width, image.height);

    // Extraire le masque en Float32Array via OffscreenCanvas
    const mc   = new OffscreenCanvas(image.width, image.height);
    const mctx = mc.getContext('2d');
    const maskCanvas = maskImg.toCanvas();
    if (maskCanvas && (maskCanvas.width || maskCanvas instanceof OffscreenCanvas)) {
      mctx.drawImage(maskCanvas, 0, 0);
    } else {
      // Fallback : maskImg expose directement ses données pixel
      const channels = maskImg.channels ?? 1;
      const raw = maskImg.data;
      const rgba = new Uint8ClampedArray(image.width * image.height * 4);
      for (let i = 0; i < image.width * image.height; i++) {
        const v = channels === 1 ? raw[i] : raw[i * channels];
        rgba[i * 4]     = v;
        rgba[i * 4 + 1] = v;
        rgba[i * 4 + 2] = v;
        rgba[i * 4 + 3] = 255;
      }
      mctx.putImageData(new ImageData(rgba, image.width, image.height), 0, 0);
    }
    const maskPx = mctx.getImageData(0, 0, image.width, image.height).data;

    // Masque : luminance perceptuelle (BiRefNet sort du niveaux de gris en RGB)
    const maskF32 = new Float32Array(image.width * image.height);
    for (let i = 0; i < maskF32.length; i++) {
      maskF32[i] = maskPx[i * 4]     * 0.299
                 + maskPx[i * 4 + 1] * 0.587
                 + maskPx[i * 4 + 2] * 0.114;
    }

    // Pixels couleurs originaux — reconstruire depuis un nouveau blob
    // (ev.data.buffer a été transféré, il faut une copie si on veut y accéder)
    // On utilise directement les données de l'image déjà chargée via RawImage.
    const origC    = new OffscreenCanvas(image.width, image.height);
    const origCtx  = origC.getContext('2d');
    // image.toCanvas() donne le canvas de l'image source
    const origCanvas = image.toCanvas();
    if (origCanvas && (origCanvas.width || origCanvas instanceof OffscreenCanvas)) {
      origCtx.drawImage(origCanvas, 0, 0);
    } else {
      // Fallback : reconstruire RGBA depuis les données brutes de RawImage
      const ch   = image.channels ?? 3;
      const raw  = image.data;
      const rgba = new Uint8ClampedArray(image.width * image.height * 4);
      for (let i = 0; i < image.width * image.height; i++) {
        rgba[i * 4]     = raw[i * ch];
        rgba[i * 4 + 1] = ch >= 2 ? raw[i * ch + 1] : raw[i * ch];
        rgba[i * 4 + 2] = ch >= 3 ? raw[i * ch + 2] : raw[i * ch];
        rgba[i * 4 + 3] = 255;
      }
      origCtx.putImageData(new ImageData(rgba, image.width, image.height), 0, 0);
    }
    const origData = origCtx.getImageData(0, 0, image.width, image.height).data;

    // Envoyer les deux buffers au thread principal (transferables = zéro copie)
    self.postMessage({
      type:   'result',
      maskF32,
      origData: origData.buffer,
      width:  image.width,
      height: image.height,
    }, [maskF32.buffer, origData.buffer]);

  } catch (e) {
    self.postMessage({ type: 'error', msg: e.message ?? String(e) });
  }
};
