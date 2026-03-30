# Deployment Guide (VPS)

Follow these steps to host your Mailmeteor Email Checker on a Linux VPS (Ubuntu/Debian recommended).

## Prerequisites

1.  **A VPS**: At least 2GB RAM is recommended for running 20 parallel browser tabs.
2.  **Docker & Docker Compose**: 
    - [Install Docker](https://docs.docker.com/engine/install/ubuntu/)
    - [Install Docker Compose](https://docs.docker.com/compose/install/)

## Setup Steps

### 1. Clone your repository
On your VPS, run:
```bash
git clone https://github.com/aasifdemand/mailmetoer_checker.git
cd mailmetoer_checker
```

### 2. Configure Environment (Optional)
If you have a `.env` file for API keys or ports, create it in the root:
```bash
nano .env
```

### 3. Build and Start the Application
Run the following command to build the image and start the container in the background:
```bash
docker compose up -d --build
```

The server will be running on `http://YOUR_VPS_IP:3000`.

### 4. Check Logs
If you encounter issues, view live logs with:
```bash
docker compose logs -f
```

## Troubleshooting

### Why Xvfb?
We use `xvfb-run` inside the Docker container to create a "Virtual Screen". This is why `headless: 'auto'` works on the VPS even though there is no monitor.

### Performance
If the server is slow or crashing:
- Decrease the number of workers in `server.js` (currently set to 2 browsers x 10 tabs).
- Increase your VPS RAM.
- Ensure your `shm_size` in `docker-compose.yml` is at least `2gb`.

### Accessing the UI
Make sure your VPS firewall (UFW) allows incoming traffic on port 3000:
```bash
sudo ufw allow 3000
```
