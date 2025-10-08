# Use uma imagem base do Python
FROM python:3.9-slim

# Defina o diretório de trabalho
WORKDIR /app

# Copie o ficheiro de dependências
COPY requirements.txt .

# Instale as dependências
RUN pip install --no-cache-dir -r requirements.txt

# Copie o seu script
COPY DigitalTwinPV_v3.py .

# Comando para executar o script quando o contêiner iniciar
CMD ["python", "-u", "DigitalTwinPV_v3.py"]