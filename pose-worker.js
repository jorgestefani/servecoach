// ServeCoach · IA de pose fora da tela principal (worker clássico).
// No iPhone, rodar o MediaPipe junto com a tela travava os toques; aqui ele roda à parte.
// O jsDelivr serve o .cjs como "application/node" (importScripts recusa); por isso baixa como texto.
let PoseLandmarker, FilesetResolver;
async function carregarLib() {
  if (PoseLandmarker) return;
  const codigo = await (await fetch('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.cjs')).text();
  const exp = {};
  new Function('exports', 'module', codigo)(exp, {exports: exp});
  ({PoseLandmarker, FilesetResolver} = exp);
}
const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
let lm = null;

self.onmessage = async (e) => {
  const d = e.data;
  if (d.tipo === 'init') {
    try {
      await carregarLib();
      const vision = await FilesetResolver.forVisionTasks(WASM);
      const opts = (delegate) => ({
        baseOptions: {
          modelAssetPath: `https://storage.googleapis.com/mediapipe-models/pose_landmarker/${d.nome}/float16/latest/${d.nome}.task`,
          delegate,
        },
        runningMode: 'VIDEO', numPoses: 1,
        minPoseDetectionConfidence: d.conf, minPosePresenceConfidence: d.conf, minTrackingConfidence: d.conf,
        outputSegmentationMasks: false,
      });
      let modo = 'CPU';
      if (d.gpu) {
        try { lm = await PoseLandmarker.createFromOptions(vision, opts('GPU')); modo = 'GPU'; }
        catch (x) { lm = null; }
      }
      if (!lm) lm = await PoseLandmarker.createFromOptions(vision, opts('CPU'));
      self.postMessage({tipo: 'pronto', modo});
    } catch (x) {
      self.postMessage({tipo: 'erro', msg: String((x && x.message) || x)});
    }
  } else if (d.tipo === 'quadro') {
    const t0 = performance.now();
    try {
      const r = lm.detectForVideo(d.img, d.ts);
      self.postMessage({tipo: 'pose', lm: (r.landmarks && r.landmarks[0]) || null, ms: performance.now() - t0});
    } catch (x) {
      self.postMessage({tipo: 'pose', lm: null, erro: String((x && x.message) || x)});
    } finally {
      try { d.img.close(); } catch (_) {}
    }
  }
};
