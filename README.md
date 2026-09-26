# Port Manager

A Windows desktop app that lists programs listening on TCP ports and lets you stop them from one window.

Use it when local projects are still running and you need to see which port they own, or free that port.

## Run from source

Requires Node.js.

```powershell
npm install
npm start
```

## Installer

Build a setup program you can copy to another Windows PC:

```powershell
npm run dist
```

The installer is created at `dist/PortManager-Setup-1.0.0.exe`. Double-click it to install Port Manager and add a desktop shortcut. The other PC does not need Node.js.

## What you can do

- See the port, process name, PID, and project command.
- Stop a process. Child processes stop with it.
- Search, hide Windows system listeners, and refresh the list automatically.

Windows may warn that the installer is unrecognized because it is not signed with a public certificate. Choose **More info**, then **Run anyway**.
