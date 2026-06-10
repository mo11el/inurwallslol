module.exports = {
  apps: [
    {
      name: "aria-agent",
      script: "npx",
      args: "tsx src/index.ts",
      cwd: "/app"
    },
    {
      name: "aria-poller",
      script: "python3",
      args: "aria-market-poller.py",
      cwd: "/app"
    }
  ]
};
