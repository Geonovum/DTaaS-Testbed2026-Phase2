version 1.3

workflow ogc_collection {
    input {
        String api_url
        String collection_id
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
