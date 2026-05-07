/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,jsx,ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        mesh: {
          bg:       '#0a0a0a',
          bg2:      '#0d0d0d',
          green:    '#00ff88',
          cyan:     '#00ffff',
          red:      '#ff3b3b',
          amber:    '#ffcc00',
          orange:   '#ff7700',
          blue:     '#0088ff',
        },
      },
      fontFamily: {
        mono: ['"Share Tech Mono"', 'monospace'],
      },
      animation: {
        'pulse-slow':   'pulse 3s cubic-bezier(0.4,0,0.6,1) infinite',
        'pulse-fast':   'pulse 1s cubic-bezier(0.4,0,0.6,1) infinite',
        'blink':        'blink 1s step-end infinite',
      },
      keyframes: {
        blink: {
          '0%, 100%': { opacity: '1' },
          '50%':       { opacity: '0' },
        },
      },
    },
  },
  plugins: [],
};
