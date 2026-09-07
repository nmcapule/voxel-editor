import { defineConfig } from 'vite'

export default defineConfig({ server: {
  host: '127.0.0.1',
  proxy: process.env.VOXEL_MODEL_PORT ? { '/api/models': { target: `http://127.0.0.1:${process.env.VOXEL_MODEL_PORT}`, changeOrigin: false } } : undefined,
} })
