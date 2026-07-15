# Dex Assistant

A local AI assistant powered by Ollama.

## Requirements

- macOS or Linux
- Docker & Docker Compose
- Node.js
- Ollama

## Setup

### 1. Clone the repository

```bash
git clone <repo-url>
cd dex-assistant
```

### 2. Install Docker

Make sure Docker is installed and running.

### 3. Install Ollama

Install Ollama from https://ollama.com

Download a model (recommended):

```bash
ollama pull llama3.2:3b
```

Start Ollama if it isn't already running:

```bash
ollama serve
```

Verify:

```bash
curl http://localhost:11434
```

Expected output:

```
Ollama is running
```

### 4. Create environment file

```bash
cp env.example .env
```

### 5. Install dependencies

```bash
npm install
```

### 6. Start Dex

```bash
npm run start
```

On the first run it will:

- Build the Python embedding service
- Download Docker images
- Start Qdrant
- Start the Embedding service
- Start SearXNG
- Start the API server

The first startup may take a few minutes.

Once everything is ready, the API will be available at:

```
http://localhost:4000
```

## Useful Commands

Start:

```bash
npm run start
```

View logs:

```bash
npm run logs
```

Stop everything:

```bash
npm run stop
```

## Configuration

Configuration is available in:

```
config/dex.yaml
```

Default model:

```yaml
ollama:
  model: llama3.2:3b
```

You can change this to any model available in your local Ollama installation.

## Using Dex

Once running, you can:

- Call the API locally from your applications.
- Use it with the Raycast extension:

  https://github.com/faizahmd2/dex-raycast-extension
