pipeline {
  agent any

  tools {
    nodejs 'node-v22'
  }

  environment {
    PROJECT_NAME = 'resultados-astro'
    WEB_IMAGE = 'resultados-astro-web:v2.0'
    API_IMAGE = 'resultados-astro-api:v2.0'
    WEB_CONTAINER = 'resultados-astro-web'
    API_CONTAINER = 'resultados-astro-api'
    DOCKER_NETWORK = 'red-gane-int'
    ENV_RESULTADOS_ASTRO = credentials('ENV_RESULTADOS_ASTRO')
  }

  stages {
    stage('Prepare Environment (.env)') {
      steps {
        script {
          echo "Cargando variables de entorno seguras para ${PROJECT_NAME}..."
          def envContent = readFile(ENV_RESULTADOS_ASTRO)
          writeFile file: './.env', text: envContent
        }
      }
    }

    stage('Verify External Docker Network') {
      steps {
        script {
          sh """
            if ! docker network inspect ${DOCKER_NETWORK} >/dev/null 2>&1; then
              echo "ERROR: La red externa ${DOCKER_NETWORK} no existe en el servidor Docker."
              exit 1
            fi
            echo "Red externa ${DOCKER_NETWORK} verificada correctamente."
          """
        }
      }
    }

    stage('Prepare Oracle Instant Client (11.2)') {
      steps {
        script {
          sh '''
            mkdir -p ./backend/instantclient_11_2
            if [ -d "/var/lib/jenkins/instantclient_11_2" ]; then
              rm -rf ./backend/instantclient_11_2/*
              cp -rf /var/lib/jenkins/instantclient_11_2/. ./backend/instantclient_11_2/
              echo "Oracle Instant Client 11.2 copiado correctamente desde /var/lib/jenkins/instantclient_11_2."
            else
              echo "ADVERTENCIA: /var/lib/jenkins/instantclient_11_2 no encontrado; el ETL operará con respaldo API interna."
            fi
          '''
        }
      }
    }

    stage('Build Docker Images (Frontend & Backend)') {
      steps {
        script {
          echo "Construyendo imágenes ${WEB_IMAGE} y ${API_IMAGE}..."
          sh 'docker compose -p resultados-astro build --pull'
        }
      }
    }

    stage('Stop Previous Project Containers') {
      steps {
        script {
          echo "Deteniendo contenedores previos de ${PROJECT_NAME} (conservando volúmenes persistentes resultados_astro_carousel y resultados_astro_data)..."
          sh 'docker compose -p resultados-astro down --remove-orphans || true'
        }
      }
    }

    stage('Deploy with Docker Compose') {
      steps {
        script {
          echo "Iniciando servicios ${WEB_CONTAINER} y ${API_CONTAINER} en la red ${DOCKER_NETWORK}..."
          sh 'docker compose -p resultados-astro up -d'
        }
      }
    }

    stage('Verify Containers & Health Endpoint') {
      steps {
        script {
          echo "Verificando estado de contenedores, persistencia y endpoint /health..."
          sh """
            sleep 5
            docker ps --filter "name=${API_CONTAINER}" --filter "status=running" | grep ${API_CONTAINER}
            docker ps --filter "name=${WEB_CONTAINER}" --filter "status=running" | grep ${WEB_CONTAINER}

            # Verificar endpoint /health y /etl/status internamente en el contenedor backend
            docker exec ${API_CONTAINER} node -e "fetch('http://127.0.0.1:3000/health').then(r=>r.json()).then(d=>{console.log('Health API:', JSON.stringify(d)); if(d.status!=='ok') process.exit(1);}).catch(e=>{console.error(e); process.exit(1);})"
            docker exec ${API_CONTAINER} node -e "fetch('http://127.0.0.1:3000/api/etl/status').then(r=>r.json()).then(d=>{console.log('ETL Loterias:', JSON.stringify({schedule: d.schedule, oracleClientReady: d.oracleClientReady, oracleConfigured: d.oracleConfigured, sourceMode: d.sourceMode, nextScheduledAt: d.nextScheduledAt}));}).catch(e=>{console.error(e); process.exit(1);})"

            # Verificar volúmenes persistentes compartidos entre backend y frontend
            docker exec ${API_CONTAINER} sh -c "test -w /app/carousel && test -w /app/data && ls -1 /app/carousel | wc -l"
            docker exec ${WEB_CONTAINER} sh -c "test -d /usr/share/nginx/html/img/carousel && ls -1 /usr/share/nginx/html/img/carousel | wc -l"
          """
        }
      }
    }
  }

  post {
    success {
      echo "Despliegue de ${PROJECT_NAME} completado y verificado exitosamente."
    }
    failure {
      echo "ERROR en el despliegue de ${PROJECT_NAME}. Mostrando logs de diagnóstico:"
      sh """
        docker logs --tail 50 ${API_CONTAINER} || true
        docker logs --tail 50 ${WEB_CONTAINER} || true
      """
    }
  }
}
