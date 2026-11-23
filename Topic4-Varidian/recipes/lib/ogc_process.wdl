version 1.3

workflow execute {
    meta {
        description: "Execute an OGC process asynchronously, poll until completion, and return the job results."
        outputs: {
            job_id: "The job id created on process execution",
            final_status: "The execution's status code",
            results: "The job's actual results",
        }
    }

    parameter_meta {
        registry_url: "Base URL of the OGC API Processes registry, for example http://localhost:8090"
        process_id: "The process id to execute"
        process_inputs: "JSON file containing the OGC execution request inputs object or full execution body"
        poll_interval_seconds: "Seconds to wait between polling attempts"
        max_poll_attempts: "Maximum number of polling attempts before failing"
    }

    input {
        String registry_url
        String process_id
        String process_inputs
        Int poll_interval_seconds = 3
        Int max_poll_attempts = 10
    }

    call execute_process {
        registry_url,
        process_id,
        process_inputs,
    }

    call poll_job {
        registry_url,
        job_id = execute_process.job_id,
        poll_interval_seconds,
        max_poll_attempts,
    }

    # Results only exist once polling has seen the job succeed
    call fetch_job_results after poll_job {
        registry_url,
        job_id = execute_process.job_id,
    }

    output {
        String job_id = execute_process.job_id
        String final_status = poll_job.status
        File results = fetch_job_results.results
    }
}

task execute_process {
    meta {
        description: "Starts an OGC process asynchronously using Prefer: respond-async."
        outputs: {
            job_id: "The job id created on process execution",
            response: "The process execution response",
            status_code: "The status code of the execution request",
        }
    }

    parameter_meta {
        registry_url: "Base URL of the OGC API Processes registry, for example http://localhost:8090"
        process_id: "The process id to execute"
        process_inputs: "Struct containing the OGC execution request inputs object or full execution body"
    }

    input {
        String registry_url
        String process_id
        String process_inputs
    }

    command <<<
        set -euo pipefail

        curl \
          --request POST \
          --url "~{registry_url}/processes/~{process_id}/execution" \
          --header "Content-Type: application/json" \
          --header "Prefer: respond-async" \
          --data '{"inputs": ~{process_inputs} }' \
          --output execution_response.json \
          --write-out "%{http_code}" \
          --silent \
          --show-error > status_code.txt

        status_code="$(cat status_code.txt)"

        if [ "$status_code" != "201" ]; then
          echo "Expected HTTP 201 from process execution, got $status_code" >&2
          cat execution_response.json >&2
          exit 1
        fi

        jq -r '.jobID // empty' execution_response.json > job_id.txt

        if [ ! -s job_id.txt ]; then
          echo "Could not find job id in execution response." >&2
          cat execution_response.json >&2
          exit 1
        fi
    >>>

    output {
        String job_id = read_string("job_id.txt")
        File response = "execution_response.json"
        Int status_code = read_int("status_code.txt")
    }

    requirements {
        container: "varidian-cook:latest"
    }
}

task poll_job {
    meta {
        description: "Polls an OGC job until it becomes successful; fails when the job fails, is dismissed or does not finish in time."
        outputs: {
            status: "What the response status was for the final poll request",
            response: "What the actual response was for the final poll request",
        }
    }

    parameter_meta {
        registry_url: "Base URL of the OGC API Processes registry, for example http://localhost:8090"
        job_id: "The job to poll success status for"
        poll_interval_seconds: "Seconds to wait between polling attempts"
        max_poll_attempts: "Maximum number of polling attempts before failing"
    }

    input {
        String registry_url
        String job_id
        Int poll_interval_seconds
        Int max_poll_attempts
    }

    command <<<
        set -euo pipefail

        attempt=1
        status="unknown"

        while [ "$attempt" -le "~{max_poll_attempts}" ]; do
          echo "Polling job ~{job_id}, attempt ${attempt}/~{max_poll_attempts}" >&2

          curl \
            --request GET \
            --url "~{registry_url}/jobs/~{job_id}" \
            --output job_status.json \
            --write-out "%{http_code}" \
            --silent \
            --show-error > status_code.txt

          status_code="$(cat status_code.txt)"

          if [ "$status_code" != "200" ]; then
            echo "Expected HTTP 200 while polling job, got $status_code" >&2
            cat job_status.json >&2
            exit 1
          fi

          status="$(jq -r '.status // empty' job_status.json)"

          echo "$status" > status.txt

          case "$status" in
            successful)
              exit 0
              ;;
            failed|dismissed)
              echo "Job ~{job_id} $status: $(jq -r '.message // empty' job_status.json)" >&2
              exit 1
              ;;
            running|accepted)
              sleep "~{poll_interval_seconds}"
              ;;
            *)
              echo "Unknown or unsupported job status: $status" >&2
              cat job_status.json >&2
              exit 1
              ;;
          esac

          attempt=$((attempt + 1))
        done

        echo "Timed out waiting for job ~{job_id} to complete." >&2
        exit 1
    >>>

    output {
        String status = read_string("status.txt")
        File response = "job_status.json"
    }

    requirements {
        container: "varidian-cook:latest"
    }
}

task fetch_job_results {
    meta {
        description: "Fetches the final OGC job results document."
        outputs: {
            results: "The job's execution resuts",
            status_code: "The status code of fetching the job's results",
        }
    }

    parameter_meta {
        registry_url: "Base URL of the OGC API Processes registry, for example http://localhost:8090"
        job_id: "The job to fetch results from"
    }

    input {
        String registry_url
        String job_id
    }

    command <<<
        set -euo pipefail

        curl \
          --request GET \
          --url "~{registry_url}/jobs/~{job_id}/results" \
          --header "Accept: application/json" \
          --output results.json \
          --write-out "%{http_code}" \
          --silent \
          --show-error > status_code.txt

        status_code="$(cat status_code.txt)"

        if [ "$status_code" != "200" ]; then
          echo "Expected HTTP 200 when fetching job results, got $status_code" >&2
          cat results.json >&2
          exit 1
        fi
    >>>

    output {
        File results = "results.json"
        Int status_code = read_int("status_code.txt")
    }

    requirements {
        container: "varidian-cook:latest"
    }
}
