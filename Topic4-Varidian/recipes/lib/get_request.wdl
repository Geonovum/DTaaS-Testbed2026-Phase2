version 1.3

workflow get_request {
    meta {
        description: "Workflow that sends an HTTP GET request"
        outputs: {
            response: "The request's response payload",
            status_code: "The request's status code"
        }
    }

    parameter_meta {
        api_url: "The URL for the request"
    }

    input {
        String api_url
    }

    call send_api_get {
        api_url
    }

    output {
        File response = send_api_get.response
        Int status_code = send_api_get.status_code
    }
}

task send_api_get {
    meta {
        description: "Task that sends the actual request"
        outputs: {
            response: "The request's response payload",
            status_code: "The request's status code"
        }
    }

    parameter_meta {
        api_url: "The URL for the request"
    }

    input {
        String api_url
    }

    command <<<
        set -euo pipefail

        curl \
          --request GET \
          --url "~{api_url}" \
          --output response.json \
          --write-out "%{http_code}" \
          --silent \
          --show-error > status_code.txt
    >>>

    output {
        File response = "response.json"
        Int status_code = read_int("status_code.txt")
    }

    requirements {
        container: "varidian-cook:latest"
    }
}
