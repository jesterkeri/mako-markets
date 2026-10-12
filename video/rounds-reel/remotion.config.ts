import { Config } from "@remotion/cli/config";

// Set REMOTION_BROWSER to a local Chrome / headless shell (cloud sessions); otherwise Remotion uses its own.
if (process.env.REMOTION_BROWSER) Config.setBrowserExecutable(process.env.REMOTION_BROWSER);
Config.setVideoImageFormat("jpeg");
Config.setConcurrency(4);
