/* Minimal GPU lookup database for the compatibility checker.
   Maps a substring of the WebGL UNMASKED_RENDERER_WEBGL string to
   approximate VRAM (in MB). The first match wins, so order matters
   (specific before generic).

   Coverage today: the ~100 most common NVIDIA / AMD / Intel GPUs on
   Steam HW Survey 2026. To extend, append entries with the GPU name
   substring (case-sensitive) and the VRAM the card actually ships.
*/
window.GPU_DB = [
  // NVIDIA RTX 50xx
  { match: 'RTX 5090', vram: 32768, vendor: 'NVIDIA' },
  { match: 'RTX 5080', vram: 16384, vendor: 'NVIDIA' },
  { match: 'RTX 5070 Ti', vram: 16384, vendor: 'NVIDIA' },
  { match: 'RTX 5070', vram: 12288, vendor: 'NVIDIA' },
  { match: 'RTX 5060 Ti', vram: 16384, vendor: 'NVIDIA' },
  { match: 'RTX 5060', vram: 8192, vendor: 'NVIDIA' },

  // NVIDIA RTX 40xx
  { match: 'RTX 4090', vram: 24576, vendor: 'NVIDIA' },
  { match: 'RTX 4080 SUPER', vram: 16384, vendor: 'NVIDIA' },
  { match: 'RTX 4080', vram: 16384, vendor: 'NVIDIA' },
  { match: 'RTX 4070 Ti SUPER', vram: 16384, vendor: 'NVIDIA' },
  { match: 'RTX 4070 Ti', vram: 12288, vendor: 'NVIDIA' },
  { match: 'RTX 4070 SUPER', vram: 12288, vendor: 'NVIDIA' },
  { match: 'RTX 4070', vram: 12288, vendor: 'NVIDIA' },
  { match: 'RTX 4060 Ti', vram: 8192, vendor: 'NVIDIA' },
  { match: 'RTX 4060', vram: 8192, vendor: 'NVIDIA' },

  // NVIDIA RTX 30xx
  { match: 'RTX 3090 Ti', vram: 24576, vendor: 'NVIDIA' },
  { match: 'RTX 3090', vram: 24576, vendor: 'NVIDIA' },
  { match: 'RTX 3080 Ti', vram: 12288, vendor: 'NVIDIA' },
  { match: 'RTX 3080', vram: 10240, vendor: 'NVIDIA' },
  { match: 'RTX 3070 Ti', vram: 8192, vendor: 'NVIDIA' },
  { match: 'RTX 3070', vram: 8192, vendor: 'NVIDIA' },
  { match: 'RTX 3060 Ti', vram: 8192, vendor: 'NVIDIA' },
  { match: 'RTX 3060', vram: 12288, vendor: 'NVIDIA' },  // 12GB variant most common
  { match: 'RTX 3050', vram: 8192, vendor: 'NVIDIA' },

  // NVIDIA RTX 20xx
  { match: 'RTX 2080 Ti', vram: 11264, vendor: 'NVIDIA' },
  { match: 'RTX 2080 SUPER', vram: 8192, vendor: 'NVIDIA' },
  { match: 'RTX 2080', vram: 8192, vendor: 'NVIDIA' },
  { match: 'RTX 2070 SUPER', vram: 8192, vendor: 'NVIDIA' },
  { match: 'RTX 2070', vram: 8192, vendor: 'NVIDIA' },
  { match: 'RTX 2060 SUPER', vram: 8192, vendor: 'NVIDIA' },
  { match: 'RTX 2060', vram: 6144, vendor: 'NVIDIA' },

  // NVIDIA GTX 16xx (no RTX cores, often under 6 GB)
  { match: 'GTX 1660 SUPER', vram: 6144, vendor: 'NVIDIA' },
  { match: 'GTX 1660 Ti', vram: 6144, vendor: 'NVIDIA' },
  { match: 'GTX 1660', vram: 6144, vendor: 'NVIDIA' },
  { match: 'GTX 1650 SUPER', vram: 4096, vendor: 'NVIDIA' },
  { match: 'GTX 1650', vram: 4096, vendor: 'NVIDIA' },

  // NVIDIA GTX 10xx (older but very common)
  { match: 'GTX 1080 Ti', vram: 11264, vendor: 'NVIDIA' },
  { match: 'GTX 1080', vram: 8192, vendor: 'NVIDIA' },
  { match: 'GTX 1070 Ti', vram: 8192, vendor: 'NVIDIA' },
  { match: 'GTX 1070', vram: 8192, vendor: 'NVIDIA' },
  { match: 'GTX 1060', vram: 6144, vendor: 'NVIDIA' },  // 6GB variant most common
  { match: 'GTX 1050 Ti', vram: 4096, vendor: 'NVIDIA' },
  { match: 'GTX 1050', vram: 2048, vendor: 'NVIDIA' },

  // AMD Radeon RX 7000
  { match: 'RX 7900 XTX', vram: 24576, vendor: 'AMD' },
  { match: 'RX 7900 XT', vram: 20480, vendor: 'AMD' },
  { match: 'RX 7800 XT', vram: 16384, vendor: 'AMD' },
  { match: 'RX 7700 XT', vram: 12288, vendor: 'AMD' },
  { match: 'RX 7600', vram: 8192, vendor: 'AMD' },

  // AMD Radeon RX 6000
  { match: 'RX 6950 XT', vram: 16384, vendor: 'AMD' },
  { match: 'RX 6900 XT', vram: 16384, vendor: 'AMD' },
  { match: 'RX 6800 XT', vram: 16384, vendor: 'AMD' },
  { match: 'RX 6800', vram: 16384, vendor: 'AMD' },
  { match: 'RX 6750 XT', vram: 12288, vendor: 'AMD' },
  { match: 'RX 6700 XT', vram: 12288, vendor: 'AMD' },
  { match: 'RX 6700', vram: 10240, vendor: 'AMD' },
  { match: 'RX 6650 XT', vram: 8192, vendor: 'AMD' },
  { match: 'RX 6600 XT', vram: 8192, vendor: 'AMD' },
  { match: 'RX 6600', vram: 8192, vendor: 'AMD' },
  { match: 'RX 6500 XT', vram: 4096, vendor: 'AMD' },

  // AMD Radeon RX 5000
  { match: 'RX 5700 XT', vram: 8192, vendor: 'AMD' },
  { match: 'RX 5700', vram: 8192, vendor: 'AMD' },
  { match: 'RX 5600 XT', vram: 6144, vendor: 'AMD' },
  { match: 'RX 5500 XT', vram: 8192, vendor: 'AMD' },

  // Intel Arc + Iris Xe (always treated as Cloud-only regardless of VRAM)
  { match: 'Arc A770', vram: 16384, vendor: 'Intel' },
  { match: 'Arc A750', vram: 8192, vendor: 'Intel' },
  { match: 'Arc A580', vram: 8192, vendor: 'Intel' },
  { match: 'Arc A380', vram: 6144, vendor: 'Intel' },
  { match: 'Iris Xe', vram: 0, vendor: 'Intel' },          // iGPU shared RAM
  { match: 'UHD Graphics', vram: 0, vendor: 'Intel' },     // iGPU
  { match: 'HD Graphics', vram: 0, vendor: 'Intel' },      // iGPU

  // Apple (Mac) — Cloud only
  { match: 'Apple', vram: 0, vendor: 'Apple' },
];
