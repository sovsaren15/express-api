# Attendance System API

Express.js backend for the Attendance System.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Download Face API models:
   ```bash
   node download-models.js
   ```

3. Start server:
   ```bash
   npm run dev
   ```

## Deployment (Vercel)

To ensure Face API models are available in the serverless environment, add a `postinstall` script to your `package.json`:

```json
"scripts": {
  "postinstall": "node download-models.js"
}
```