import { defineConfig } from "vite";

export default defineConfig(({ command, mode }) => {
  return {
    build: {
      lib: {
        entry: "src/index.js",
        name: "AnyCableElements",
      },
    },
  };
});
