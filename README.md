# Decentralized Charity Platform (DCP)

![Node.js](https://img.shields.io/badge/Node.js-20.x-339933?logo=node.js&logoColor=white)
![Next.js](https://img.shields.io/badge/Next.js-14-black?logo=next.js)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)
![MongoDB](https://img.shields.io/badge/MongoDB-7-47A248?logo=mongodb&logoColor=white)
![Hardhat](https://img.shields.io/badge/Hardhat-3-F5D061)
![Solidity](https://img.shields.io/badge/Solidity-0.8.20-363636?logo=solidity)

DCP is a hybrid Web2/Web3 charity platform designed to make donation flows transparent, auditable, and easier to operate. The system combines a Next.js frontend, an Express.js backend, MongoDB for off-chain data, and Solidity smart contracts on Polygon Amoy Testnet.

The platform supports donors, charity organizations, system administrators, and regulatory bodies. It records donation activity, manages project lifecycle data, applies ranking logic inspired by Quadratic Funding, and supports multisignature disbursement workflows for accountable fund release.

## Table of Contents

- [Introduction & Project Description](#introduction--project-description)
- [Features](#features)
- [Installation](#installation)
- [Usage](#usage)

## Introduction & Project Description

### Project Overview

| Item | Details |
| --- | --- |
| Project name | Decentralized Charity Platform (DCP) |
| Project type | Full-stack decentralized application / charity management platform |
| Audience | Developers |
| Frontend | Next.js 14, React 18, TypeScript, Tailwind CSS, React Query, Zustand |
| Backend | Node.js, Express.js, TypeScript, MongoDB, Mongoose, JWT, Google OAuth |
| Blockchain | Solidity, Hardhat, OpenZeppelin, ethers.js, Polygon Amoy Testnet |
| Infrastructure | Docker, Docker Compose, MongoDB, Redis, Nginx reverse proxy |

### Repository Structure

```text
.
├── BE/                  # Express.js backend API and workers
├── FE/                  # Next.js frontend application
├── Blockchain/          # Solidity contracts, Hardhat config, deployment scripts
├── E2E.Tests/           # End-to-end test project
├── deploy/              # Production deployment examples and environment templates
├── scripts/             # Utility scripts
├── docker-compose.prod.yml
└── README.md
```

### Core Architecture

DCP uses a hybrid architecture:

- The frontend provides donor, organization, administrator, and regulatory user interfaces.
- The backend owns authentication, business workflows, off-chain persistence, ranking services, payment integration boundaries, and API orchestration.
- Smart contracts provide token accounting, project donation recording, ranking support, vault management, and multisignature disbursement controls.
- MongoDB stores operational data that should remain queryable and flexible off-chain.
- Redis is available for runtime infrastructure and worker-oriented flows.

## Features

- **Transparent donation lifecycle**: Track deposits, donations, project records, and disbursement-related data across backend and blockchain components.
- **Hybrid payment model**: Supports traditional payment gateway integration boundaries and token-based Web3 flows.
- **Smart contract accountability**: Includes ERC-20 charity token logic, donation ranking, disbursement vault, and multisignature disbursement contracts.
- **Role-based workflows**: Supports donors, charity organizations, system administrators, and regulatory bodies.
- **Project ranking services**: Provides backend ranking models, incremental ranking updates, reconciliation workers, and ranking APIs.
- **Security-focused backend**: Uses JWT authentication, Google OAuth support, CORS controls, Helmet, CSRF middleware, rate limiting, and role authorization middleware.
- **Evidence handling**: Includes frontend and backend flows for donation and disbursement evidence, with IPFS/Pinata-oriented utilities.
- **Production deployment assets**: Provides Dockerfiles, Docker Compose production configuration, environment templates, MongoDB initialization, and Nginx reverse proxy examples.

## Installation

### Prerequisites

Install the following tools before setting up the project:

| Tool | Recommended Version | Purpose |
| --- | --- | --- |
| Node.js | 20.x or later | Run frontend, backend, and blockchain tooling |
| npm | 10.x or later | Install JavaScript dependencies |
| MongoDB | 7.x | Backend database |
| Redis | 7.x | Runtime cache/queue infrastructure |
| Docker | Latest stable | Optional production-like local services |
| Docker Compose | Latest stable | Production deployment stack |

### 1. Clone the Repository

```bash
git clone <repository-url>
cd DCP
```

### 2. Install Dependencies

Install dependencies for each workspace:

```bash
cd BE
npm install

cd ../FE
npm install

cd ../Blockchain
npm install
```

### 3. Configure Environment Variables

Create environment files from the provided examples:

```bash
cp BE/.env.example BE/.env
cp FE/.env.example FE/.env.local
cp Blockchain/.env.example Blockchain/.env
```

Update the generated files with values for your local environment.

#### Backend Environment

```env
PORT=4000
NODE_ENV=development
MONGODB_URI=mongodb://localhost:27017/dcp
REDIS_URL=redis://localhost:6379
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
JWT_SECRET=your_strong_jwt_secret_min_32_chars
JWT_ISSUER=dcp-backend
JWT_AUDIENCE=dcp-users
JWT_EXPIRES_IN=24h
CORS_ALLOWED_ORIGINS=http://localhost:3000
REQUEST_BODY_LIMIT=5mb
RUN_WORKERS=true
```

#### Frontend Environment

```env
NEXT_PUBLIC_API_BASE_URL=http://localhost:4000
NEXT_PUBLIC_GOOGLE_CLIENT_ID=your_google_client_id_here
NEXT_PUBLIC_AMOY_CHAIN_ID=80002
NEXT_PUBLIC_BLOCKCHAIN_CHAIN_ID=80002
NEXT_PUBLIC_BLOCKCHAIN_EXPLORER_TX_BASE_URL=https://amoy.polygonscan.com/tx/
NEXT_PUBLIC_CHARITY_TOKEN_ADDRESS=0x...
NEXT_PUBLIC_DONATION_RANKING_ADDRESS=0x...
NEXT_PUBLIC_DONATION_RANKING_CONTRACT_ADDRESS=0x...
```

#### Blockchain Environment

```env
AMOY_RPC_URL=https://rpc-amoy.polygon.technology
DEPLOYER_PRIVATE_KEY=your_private_key
POLYGONSCAN_API_KEY=your_polygonscan_api_key
```

### 4. Start Required Services

Start MongoDB and Redis locally, or use your preferred managed services.

Example with Docker:

```bash
docker run --name dcp-mongo -p 27017:27017 -d mongo:7
docker run --name dcp-redis -p 6379:6379 -d redis:7-alpine
```

### 5. Compile Smart Contracts

```bash
cd Blockchain
npm run compile
```

To deploy contracts to Polygon Amoy Testnet:

```bash
npm run deploy
```

After deployment, copy the generated contract addresses into `FE/.env.local` and any backend environment variables that depend on contract addresses.

### 6. Build the Applications

Backend:

```bash
cd BE
npm run build
```

Frontend:

```bash
cd FE
npm run build
```

## Usage

### Run the Backend API

```bash
cd BE
npm run dev
```

The backend runs on:

```text
http://localhost:4000
```

Useful backend commands:

| Command | Description |
| --- | --- |
| `npm run dev` | Start the backend in development mode with file watching |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled backend |
| `npm test` | Run backend tests with Vitest |
| `npm run lint` | Run ESLint |

### Run the Frontend

```bash
cd FE
npm run dev
```

The frontend runs on:

```text
http://localhost:3000
```

Useful frontend commands:

| Command | Description |
| --- | --- |
| `npm run dev` | Start the Next.js development server |
| `npm run build` | Build the production frontend |
| `npm start` | Run the production frontend server |
| `npm run lint` | Run Next.js linting |

### Work with Smart Contracts

```bash
cd Blockchain
npm run compile
npm test
```

Useful blockchain commands:

| Command | Description |
| --- | --- |
| `npm run compile` | Compile Solidity contracts with Hardhat |
| `npm test` | Run smart contract tests |
| `npm run dev:node` | Start a local Hardhat node |
| `npm run deploy:local` | Deploy contracts to the local Hardhat network |
| `npm run deploy` | Deploy contracts to Polygon Amoy Testnet |

### Run a Local Development Flow

Use three terminal sessions:

```bash
# Terminal 1: backend
cd BE
npm run dev
```

```bash
# Terminal 2: frontend
cd FE
npm run dev
```

```bash
# Terminal 3: blockchain, optional local chain
cd Blockchain
npm run dev:node
```

Then open:

```text
http://localhost:3000
```

### Production Deployment with Docker Compose

The repository includes a production-oriented Compose file. Before running it, create runtime environment files from the templates in `deploy/env/` and create the frontend build-time interpolation file from `deploy/compose.env.example`:

```text
/opt/dcp/env/mongo.env
/opt/dcp/env/backend.env
/opt/dcp/env/frontend.env
/opt/dcp/env/compose.env
/opt/dcp/env/feedback-client-ip-hmac.key
```

The feedback SSR identity HMAC is a single Docker secret shared read-only by the backend, worker and
frontend. Create `/opt/dcp/env/feedback-client-ip-hmac.key` with a random value of at least 32 characters
and set its permissions to `600`; do not duplicate it in either env file or commit it.

Run Compose with the interpolation file so every `NEXT_PUBLIC_*` build argument, including Sentry configuration, is embedded in the frontend bundle:

```bash
docker compose --env-file /opt/dcp/env/compose.env -f docker-compose.prod.yml up -d --build
```

The production stack includes:

| Service | Description |
| --- | --- |
| `mongo` | MongoDB database |
| `redis` | Redis service |
| `backend` | Express.js API server |
| `backend-worker` | Backend worker process |
| `frontend` | Next.js application |

For reverse proxy setup, use `deploy/nginx/dcp.conf.example` as a starting point.
