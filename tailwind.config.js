/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: { extend: { boxShadow: { glow: '0 0 50px rgba(34,211,238,.12)' } } },
  plugins: []
};
