FROM node:20-bullseye

# Install Python and pip
RUN apt-get update && apt-get install -y python3 python3-pip && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install pm2 globally
RUN npm install -g pm2

# Copy package files and install node dependencies
COPY package*.json ./
RUN npm install

# Install Python dependencies
RUN pip3 install yfinance

# Copy application code and state files
COPY . .

# Run both processes via pm2
CMD ["pm2-runtime", "start", "pm2.config.js"]
