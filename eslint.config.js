import tseslint from 'typescript-eslint';

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    // Determinism guard: the sim must be a pure integer function of
    // (state, ticcmds). Floats, wall clocks, and ambient randomness are
    // desync bugs waiting to happen — ban them at lint level.
    files: ['src/sim/**/*.ts', 'src/blocks/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'Date', message: 'No wall-clock time in the deterministic sim.' },
        { name: 'performance', message: 'No wall-clock time in the deterministic sim.' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Use the ported Doom RNG (P_Random/M_Random).' },
        { object: 'Math', property: 'sin', message: 'Use the finesine table.' },
        { object: 'Math', property: 'cos', message: 'Use the finesine table.' },
        { object: 'Math', property: 'tan', message: 'Use the finetangent table.' },
        { object: 'Math', property: 'atan2', message: 'Use tantoangle/SlopeDiv.' },
        { object: 'Math', property: 'sqrt', message: 'No float math in the sim.' },
        { object: 'Math', property: 'pow', message: 'No float math in the sim.' },
        { object: 'Math', property: 'hypot', message: 'No float math in the sim.' },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['three', 'three/*', '**/render/*', '**/audio/*', '**/input/*', '**/net/*'],
              message: 'The sim must not depend on renderer/audio/input/net code.' },
          ],
        },
      ],
    },
  },
);
