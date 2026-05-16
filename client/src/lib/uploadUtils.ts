/**
 * Upload utilities with progress tracking and video compression
 */

export interface UploadProgress {
  phase: 'compressing' | 'uploading';
  percent: number; // 0-100
  label: string;
}

type ProgressCallback = (progress: UploadProgress) => void;

/**
 * Compress a video file using canvas + MediaRecorder.
 * Target: reduce to ~720p, lower bitrate.
 * Falls back to original file if compression fails or browser doesn't support it.
 */
export async function compressVideo(
  file: File,
  onProgress?: (percent: number) => void,
  targetHeight = 720,
  videoBitrate = 1_500_000, // 1.5 Mbps
): Promise<Blob> {
  // Check browser support
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported('video/webm;codecs=vp8')) {
    console.warn('MediaRecorder not supported, skipping video compression');
    return file;
  }

  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    const url = URL.createObjectURL(file);
    video.src = url;

    video.onloadedmetadata = () => {
      // Calculate target dimensions
      let { videoWidth: w, videoHeight: h } = video;
      if (h > targetHeight) {
        w = Math.round((w * targetHeight) / h);
        h = targetHeight;
      }
      // Make dimensions even (required by some codecs)
      w = w % 2 === 0 ? w : w + 1;
      h = h % 2 === 0 ? h : h + 1;

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) { URL.revokeObjectURL(url); resolve(file); return; }

      const stream = canvas.captureStream(24); // 24 fps
      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(stream, {
          mimeType: 'video/webm;codecs=vp8',
          videoBitsPerSecond: videoBitrate,
        });
      } catch {
        URL.revokeObjectURL(url); resolve(file); return;
      }

      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      recorder.onstop = () => {
        URL.revokeObjectURL(url);
        const compressed = new Blob(chunks, { type: 'video/webm' });
        // Only use compressed if it's actually smaller
        if (compressed.size < file.size * 0.95) {
          resolve(compressed);
        } else {
          resolve(file);
        }
      };
      recorder.onerror = () => { URL.revokeObjectURL(url); resolve(file); };

      const duration = video.duration;
      let animFrameId: number;

      const drawFrame = () => {
        if (video.ended || video.paused) {
          recorder.stop();
          cancelAnimationFrame(animFrameId);
          return;
        }
        ctx.drawImage(video, 0, 0, w, h);
        if (onProgress && duration > 0) {
          onProgress(Math.min(99, Math.round((video.currentTime / duration) * 100)));
        }
        animFrameId = requestAnimationFrame(drawFrame);
      };

      recorder.start(100); // collect data every 100ms
      video.play().then(() => {
        animFrameId = requestAnimationFrame(drawFrame);
      }).catch(() => {
        URL.revokeObjectURL(url);
        resolve(file);
      });

      // Safety timeout: if video is too long (>5 min), skip compression
      const timeout = setTimeout(() => {
        if (recorder.state === 'recording') {
          video.pause();
          recorder.stop();
          cancelAnimationFrame(animFrameId);
        }
      }, Math.min(duration * 1200, 300_000)); // 1.2x realtime or 5 min max

      video.onended = () => {
        clearTimeout(timeout);
        if (recorder.state === 'recording') {
          recorder.stop();
        }
        cancelAnimationFrame(animFrameId);
      };
    };

    video.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
  });
}

/**
 * Upload files with progress tracking using XMLHttpRequest
 */
export function uploadWithProgress(
  url: string,
  formData: FormData,
  onProgress?: (percent: number) => void,
): Promise<{ ok: boolean; status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };

    xhr.onload = () => {
      let data: any;
      try { data = JSON.parse(xhr.responseText); } catch { data = { error: `伺服器回應異常 (${xhr.status})` }; }
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, data });
    };

    xhr.onerror = () => reject(new Error('網路連線異常'));
    xhr.ontimeout = () => reject(new Error('上傳逾時'));
    xhr.timeout = 300_000; // 5 min timeout

    xhr.send(formData);
  });
}

/**
 * Compress image helper (same as existing compressImage but exported)
 */
export async function compressImage(file: File, maxWidth = 1920, quality = 0.8): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (width > maxWidth) {
        height = Math.round((height * maxWidth) / width);
        width = maxWidth;
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) { resolve(file); return; }
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob(
        (blob) => { blob ? resolve(blob) : resolve(file); },
        "image/jpeg",
        quality
      );
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}

/**
 * Process files for upload: compress images and videos, then upload with progress
 */
export async function processAndUpload(
  files: FileList,
  uploadUrl: string,
  onProgress: ProgressCallback,
): Promise<{ success: boolean; urls?: string[]; error?: string }> {
  const totalFiles = files.length;
  const processedBlobs: { blob: Blob; name: string }[] = [];

  // Phase 1: Compress files
  for (let i = 0; i < totalFiles; i++) {
    const file = files[i];
    const fileLabel = `${i + 1}/${totalFiles}`;

    if (file.type.startsWith('video/') && file.size > 5 * 1024 * 1024) {
      // Compress video (only if > 5MB)
      onProgress({
        phase: 'compressing',
        percent: Math.round((i / totalFiles) * 100),
        label: `壓縮影片中 (${fileLabel})...`,
      });
      const compressed = await compressVideo(file, (p) => {
        onProgress({
          phase: 'compressing',
          percent: Math.round(((i + p / 100) / totalFiles) * 100),
          label: `壓縮影片中 (${fileLabel}) ${p}%`,
        });
      });
      const ext = compressed.type === 'video/webm' ? '.webm' : '';
      const name = ext && !file.name.endsWith('.webm')
        ? file.name.replace(/\.[^.]+$/, '.webm')
        : file.name;
      processedBlobs.push({ blob: compressed, name });
    } else if (file.type.startsWith('image/') && file.size > 500 * 1024) {
      // Compress image (only if > 500KB)
      onProgress({
        phase: 'compressing',
        percent: Math.round((i / totalFiles) * 100),
        label: `壓縮圖片中 (${fileLabel})...`,
      });
      const compressed = await compressImage(file);
      processedBlobs.push({ blob: compressed, name: file.name });
    } else {
      processedBlobs.push({ blob: file, name: file.name });
    }
  }

  // Phase 2: Upload
  onProgress({ phase: 'uploading', percent: 0, label: '上傳中...' });
  const formData = new FormData();
  for (const { blob, name } of processedBlobs) {
    formData.append('file', blob, name);
  }

  try {
    const result = await uploadWithProgress(uploadUrl, formData, (p) => {
      onProgress({ phase: 'uploading', percent: p, label: `上傳中 ${p}%` });
    });

    if (!result.ok) {
      return { success: false, error: result.data?.error || `上傳失敗 (${result.status})` };
    }
    if (result.data?.success && result.data?.urls) {
      return { success: true, urls: result.data.urls };
    }
    return { success: false, error: result.data?.error || '上傳失敗' };
  } catch (err: any) {
    return { success: false, error: `上傳失敗：${err.message || '網路連線異常'}` };
  }
}
