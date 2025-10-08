import paho.mqtt.client as mqtt
import json
import math

# Configurações do broker
BROKER = "aws21.ddns.net"
PORT = 1883
TOPICS = [
    "iot/painel/INA226",
    "iot/painel/TSL2591",
    "iot/painel/AHT20",
    "iot/painel/BMP280",
    "iot/painel/pins",
    "iot/painel/irradiance"
]

# Tópico para publicar potência estimada
TOPIC_POWER = "iot/painel/estimatedPower"

# Dicionário global com últimos valores recebidos
dados_sensores = {
    "voltage": None,
    "current": None,
    "power": None,
    "lux": None,
    "temperature_AHT20": None,
    "humidity": None,
    "temperature_BMP280": None,
    "pressure": None,
    "irradiance": None,
    "pins": {}
}

# Características do módulo PV
voc0 = 22.06
isc0 = 0.70
vmp0 = 18.81
imp0 = 0.63

kv = vmp0 / voc0
ki = imp0 / isc0

alphav = -0.31 / 100
alphai = 0.06 / 100

G0 = 1000
T0 = 25
q = 1.602e-19
k = 1.3806503e-23
Ns = 36

contador = 0


def calcular_potencia():
    """Calcula a potência estimada com base nos dados atuais dos sensores."""
    T = dados_sensores["temperature_AHT20"]
    G = dados_sensores["irradiance"]
    V = dados_sensores["voltage"]

    global contador

    if T is None or G is None or V is None:
        contador += 1
        print("⚠️ Dados incompletos para calcular potência:", contador)
        return

    # Corrige valor de G caso seja negativo
    G = max(G, 0)

    # Calcula voc, isc, vmp, imp
    Vt = k * (T + 273.15) / q

    try:
        voc = Ns * Vt * math.log(G / G0 + 1e-9) + voc0 * (1 + alphav * (T - T0))
        isc = isc0 * G / G0 * (1 + alphai * (T - T0))
        imp = isc * ki
        vmp = voc * kv

        # Função degrau unitário
        if V - vmp < 0:
            u1 = 0
            u2 = 1
        elif V - vmp > 0:
            u1 = 1
            u2 = 0
        else:
            u1 = 0.5
            u2 = 0.5

        # Parâmetros modelo gêmeo digital PV
        a = imp / math.pow(voc - vmp, 2) * (voc / vmp - 2)
        b = -2 * vmp * imp / math.pow(voc - vmp, 2) * (voc / vmp - 2) - imp / vmp
        c = imp * voc / vmp - voc * imp * math.pow(voc - 2 * vmp, 2) / (vmp * math.pow(voc - vmp, 2))
        d = -vmp * (2 * imp - isc) / (imp * math.pow(imp - isc, 2))
        e = 2 * vmp * (2 * imp - isc) / math.pow(imp - isc, 2) - vmp / imp
        f = vmp * isc * (2 * isc - 3 * imp) / math.pow(imp - isc, 2)

        i = (a * V**2 + b * V + c) * u1 + (-e - math.sqrt(max(e**2 - 4 * d * (f - V), 0))) / (2 * d) * u2
        estimatedPower = V * i * 1000  # converte para mW ou ajusta conforme escala

        # Publica no MQTT em formato JSON
        payload = json.dumps({"estimatedPower": round(estimatedPower, 3)})
        client.publish(TOPIC_POWER, payload)
        print(f"🔋 Potência estimada publicada: {payload}")

    except Exception as ex:
        print("⚠️ Erro no cálculo da potência:", ex)


def on_connect(client, userdata, flags, rc):
    if rc == 0:
        print("✅ Conectado ao broker MQTT!")
        for topic in TOPICS:
            client.subscribe(topic)
            print(f"📡 Inscrito no tópico: {topic}")
    else:
        print("❌ Falha na conexão. Código:", rc)


def on_message(client, userdata, msg):
    try:
        payload = msg.payload.decode("utf-8")
        data = json.loads(payload)
    except Exception as e:
        print(f"⚠️ Erro ao processar payload de {msg.topic}: {e}")
        return

    # Atualiza os dados conforme o tópico
    if msg.topic == "iot/painel/INA226":
        dados_sensores["voltage"] = data.get("voltage")
        dados_sensores["current"] = data.get("current")
        dados_sensores["power"] = data.get("power")
        print("📥 Potência real recebida:", dados_sensores["power"])

        # ✅ Só calcula se todos os dados necessários estiverem disponíveis
        if all(dados_sensores[k] is not None for k in ("irradiance", "temperature_AHT20", "voltage")):
            calcular_potencia()
        else:
            print("⏳ Aguardando dados suficientes para estimar potência.")

    elif msg.topic == "iot/painel/TSL2591":
        dados_sensores["lux"] = data.get("lux")

    elif msg.topic == "iot/painel/AHT20":
        dados_sensores["temperature_AHT20"] = data.get("temperature")
        dados_sensores["humidity"] = data.get("humidity")

    elif msg.topic == "iot/painel/BMP280":
        dados_sensores["temperature_BMP280"] = data.get("temperature")
        dados_sensores["pressure"] = data.get("pressure")

    elif msg.topic == "iot/painel/irradiance":
        dados_sensores["irradiance"] = data.get("irradiance")

    elif msg.topic == "iot/painel/pins":
        dados_sensores["pins"].update(data)


# Cria cliente MQTT
client = mqtt.Client()
client.on_connect = on_connect
client.on_message = on_message

# Conecta e mantém loop
client.connect(BROKER, PORT, 60)
client.loop_forever()
