import { Config } from '@remotion/cli/config';
import { resolve } from 'node:path';

// Product components resolve React from the root package. Resolve Remotion's
// browser imports to that same instance so hooks work across both packages.
// Run through the video package scripts (their working directory is video/).
Config.overrideWebpackConfig(config => ({
  ...config,
  resolve: {
    ...config.resolve,
    alias: {
      ...config.resolve?.alias,
      react: resolve('../node_modules/react'),
      'react-dom': resolve('../node_modules/react-dom'),
    },
  },
}));
