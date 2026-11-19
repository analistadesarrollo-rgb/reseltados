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
          echo "Deteniendo contenedores previos de ${PROJECT_NAME} (sin afectar otros proyectos ni volúmenes)..."
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
          echo "Verificando estado de contenedores y endpoint /health..."
          sh """
            sleep 5
            docker ps --filter "name=${API_CONTAINER}" --filter "status=running" | grep ${API_CONTAINER}
            docker ps --filter "name=${WEB_CONTAINER}" --filter "status=running" | grep ${WEB_CONTAINER}

            # Verificar endpoint /health internamente en el contenedor backend
            docker exec ${API_CONTAINER} node -e "fetch('http://127.0.0.1:3000/health').then(r=>r.json()).then(d=>{console.log('Health API:', JSON.stringify(d)); if(d.status!=='ok') process.exit(1);}).catch(e=>{console.error(e); process.exit(1);})"
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
