$root = $PSScriptRoot
$port = 8734

$mime = @{
  ".html" = "text/html"
  ".js"   = "application/javascript"
  ".css"  = "text/css"
  ".json" = "application/json"
  ".svg"  = "image/svg+xml"
}

$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Any, $port)
$listener.Start()
Write-Host "Serving $root on port $port (all interfaces)"

while ($true) {
  $client = $listener.AcceptTcpClient()
  $client.ReceiveTimeout = 5000
  $client.SendTimeout = 5000
  try {
    $stream = $client.GetStream()
    $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::ASCII)
    $requestLine = $reader.ReadLine()

    if (-not [string]::IsNullOrEmpty($requestLine)) {
      $headerLine = $reader.ReadLine()
      while (-not [string]::IsNullOrEmpty($headerLine)) { $headerLine = $reader.ReadLine() }

      $localPath = "/index.html"
      if ($requestLine -match '^\S+\s+(\S+)\s+HTTP') {
        $localPath = $matches[1]
        if ($localPath -eq "/") { $localPath = "/index.html" }
        $localPath = [Uri]::UnescapeDataString($localPath.Split('?')[0])
      }

      $filePath = Join-Path $root $localPath.TrimStart("/")
      $exists = Test-Path $filePath -PathType Leaf

      if ($exists) {
        $ext = [System.IO.Path]::GetExtension($filePath)
        $contentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { "application/octet-stream" }
        $bodyBytes = [System.IO.File]::ReadAllBytes($filePath)
        $status = "200 OK"
      } else {
        $contentType = "text/plain"
        $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes("Not found")
        $status = "404 Not Found"
      }

      $headerText = "HTTP/1.1 $status`r`nContent-Type: $contentType`r`nContent-Length: $($bodyBytes.Length)`r`nCache-Control: no-store, must-revalidate`r`nConnection: close`r`n`r`n"
      $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($headerText)
      $stream.Write($headerBytes, 0, $headerBytes.Length)
      $stream.Write($bodyBytes, 0, $bodyBytes.Length)
      $stream.Flush()
    }
  } catch {
  } finally {
    $client.Close()
  }
}
