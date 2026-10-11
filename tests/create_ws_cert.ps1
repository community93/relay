$ErrorActionPreference='Stop'
$taskRoot=Split-Path -Parent $PSScriptRoot
$qaPath=[IO.Path]::GetFullPath((Join-Path $taskRoot '.design-qa'))
$certPath=[IO.Path]::GetFullPath((Join-Path $qaPath 'ws-certificate'))
if(-not $certPath.StartsWith($qaPath+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Invalid certificate fixture path'}
[IO.Directory]::CreateDirectory($certPath) | Out-Null
$rsa=[Security.Cryptography.RSA]::Create(2048)
try {
    $request=[Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=localhost',$rsa,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1)
    $san=[Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
    $san.AddDnsName('localhost')
    $san.AddIpAddress([Net.IPAddress]::Parse('127.0.0.1'))
    $request.CertificateExtensions.Add($san.Build())
    $cert=$request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5),[DateTimeOffset]::UtcNow.AddDays(1))
    [IO.File]::WriteAllText((Join-Path $certPath 'cert.pem'),$cert.ExportCertificatePem())
    [IO.File]::WriteAllText((Join-Path $certPath 'key.pem'),$rsa.ExportPkcs8PrivateKeyPem())
    $cert.Dispose()
} finally { $rsa.Dispose() }
