import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  // GitHub Pages serves projects under `/<repo>/`. In Actions, `GITHUB_REPOSITORY`
  // is set to `<owner>/<repo>`; locally it's typically undefined.
  base: (() => {
    const repo = process.env.GITHUB_REPOSITORY?.split('/')[1]
    return repo ? `/${repo}/` : '/'
  })(),
  plugins: [react()],
})
