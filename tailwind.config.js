/** @type {import('tailwindcss').Config} */
//
// Records By Grevo — design tokens
//
// Identita: studiová technika. Vrstvený teplý grafit (ne čistá černá),
// wolframová jantarová jako akční barva (studiové lampy, VU metry),
// REC červená vyhrazená pro nahrávání a destruktivní akce, monospace
// timecode pro všechna čísla. Ostřejší rádiusy než výchozí blob-look.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: '#0F0F10', // neutrální grafit, ne čerň
          elev: '#161618',
          card: '#1C1C1F',
          border: '#2B2B2F',
        },
        text: {
          primary: '#F2F2F0',
          secondary: '#9A9A9E',
          muted: '#68686E',
        },
        // Akční barva je v monochromu světlo, ne odstín: rozsvícená plocha.
        accent: {
          DEFAULT: '#F2F2F0',
          hover: '#FAFAF8',
          subtle: 'rgba(242, 242, 240, 0.10)',
        },
        // Jediná barva v celé paletě. Výhradně sémanticky: nahrávání
        // (tally light) a destruktivní akce. Nikdy jako dekorace.
        danger: '#F5453C',
        // V monochromu se úspěch značí světlem, ne zelenou.
        success: '#F2F2F0',
      },

      fontFamily: {
        display: [
          '"Bricolage Grotesque Variable"',
          '-apple-system',
          'system-ui',
          'sans-serif',
        ],
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          'Inter',
          'system-ui',
          'sans-serif',
        ],
        mono: [
          'ui-monospace',
          'SF Mono',
          'JetBrains Mono',
          'Menlo',
          'monospace',
        ],
      },
      borderRadius: {
        lg: '8px',
        xl: '10px',
        '2xl': '14px',
      },
      boxShadow: {
        soft: '0 4px 20px rgba(0, 0, 0, 0.45)',
        glow: '0 0 0 1px rgba(242, 242, 240, 0.20), 0 4px 24px rgba(0, 0, 0, 0.55)',
        rec: '0 0 0 1px rgba(245, 69, 60, 0.35), 0 0 32px rgba(245, 69, 60, 0.25)',
      },
      animation: {
        'pulse-soft': 'pulse 2s ease-in-out infinite',
        'fade-in': 'fadeIn 200ms ease-out',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
};
