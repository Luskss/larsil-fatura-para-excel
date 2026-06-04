/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./*.html'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Montserrat', 'sans-serif'],
      },
      colors: {
        primary:   '#2c5529',
        'primary-mid': '#3d7a3a',
        accent:    '#4db55e',
        'accent-light': '#a0d063',
        'accent-glow':  '#6cd47e',
        'accent-text':  '#a0d87a',
      },
      backdropBlur: {
        '2xs': '4px',
        xs:  '8px',
        sm:  '12px',
        md:  '16px',
        lg:  '20px',
        xl:  '24px',
        '2xl': '40px',
      },
      keyframes: {
        blobDrift: {
          'from': { transform: 'translate(0,0) scale(1)' },
          'to':   { transform: 'translate(40px,30px) scale(1.1)' },
        },
        fadeUp: {
          'from': { opacity: '0', transform: 'translateY(30px)' },
          'to':   { opacity: '1', transform: 'translateY(0)' },
        },
        fadeIn: {
          'from': { opacity: '0', transform: 'translateY(-4px)' },
          'to':   { opacity: '1', transform: 'translateY(0)' },
        },
        spin: {
          'to': { transform: 'rotate(360deg)' },
        },
      },
      animation: {
        'blob-slow':  'blobDrift 18s ease-in-out infinite alternate',
        'blob-slower':'blobDrift 22s ease-in-out infinite alternate-reverse',
        'blob-a':     'blobDrift 20s ease-in-out infinite alternate',
        'blob-b':     'blobDrift 26s ease-in-out infinite alternate-reverse',
        'fade-up':    'fadeUp 0.5s ease both',
        'fade-in':    'fadeIn 0.2s ease both',
        'spin-fast':  'spin 0.7s linear infinite',
      },
      boxShadow: {
        'glass':  '0 32px 80px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.12)',
        'card':   '0 8px 32px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.10)',
        'nav':    '0 2px 24px rgba(0,0,0,.40)',
        'btn-green': '0 6px 24px rgba(77,181,94,.25)',
        'btn-green-hover': '0 8px 32px rgba(77,181,94,.40)',
        'btn-blue':  '0 6px 24px rgba(59,91,219,.25)',
        'btn-amber': '0 6px 24px rgba(194,112,53,.25)',
        'export':    '0 4px 16px rgba(77,181,94,.30)',
        'export-hover':'0 6px 24px rgba(77,181,94,.40)',
      },
    },
  },
  plugins: [],
}
