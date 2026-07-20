<?php
declare(strict_types=1);

$configFile = __DIR__ . '/config.php';
if (!is_file($configFile)) {
    jsonResponse(['error' => 'Configuración del servidor no disponible.'], 503);
}
$config = require $configFile;

ini_set('display_errors', '0');
header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');

session_name('fvram_session');
session_set_cookie_params([
    'lifetime' => 28800,
    'path' => '/fvram/',
    'httponly' => true,
    'samesite' => 'Strict',
]);
session_start();

function jsonResponse(array $data, int $status = 200): never {
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function body(): array {
    $decoded = json_decode(file_get_contents('php://input') ?: '{}', true);
    return is_array($decoded) ? $decoded : [];
}

function clean(mixed $value, int $max): string {
    $value = preg_replace('/\s+/u', ' ', strip_tags((string)($value ?? '')));
    return mb_substr(trim($value), 0, $max);
}

function db(): PDO {
    global $config;
    static $pdo;
    if (!$pdo) {
        $pdo = new PDO($config['db_dsn'], $config['db_user'], $config['db_password'], [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]);
    }
    return $pdo;
}

function requireAdmin(): void {
    if (empty($_SESSION['admin'])) jsonResponse(['error' => 'Sesión administrativa requerida.'], 401);
    $_SESSION['last_seen'] = time();
}

function validateReport(array $input): array {
    $data = [
        'patientName' => clean($input['patientName'] ?? '', 120),
        'dob' => clean($input['dob'] ?? '', 10),
        'room' => strtoupper(clean($input['room'] ?? '', 20)),
        'drug' => clean($input['drug'] ?? '', 150),
        'reactionDate' => clean($input['reactionDate'] ?? '', 10),
        'reactionTime' => clean($input['reactionTime'] ?? '', 8),
        'description' => clean($input['description'] ?? '', 1200),
        'reporterName' => clean($input['reporterName'] ?? '', 120),
        'reporterPosition' => clean($input['reporterPosition'] ?? '', 80),
    ];
    $namePattern = "/^[A-Za-zÁÉÍÓÚáéíóúÑñÜü'.,\-\s]+$/u";
    $today = date('Y-m-d');
    if (mb_strlen($data['patientName']) < 5 || !preg_match($namePattern, $data['patientName'])) throw new InvalidArgumentException('Nombre de paciente inválido.');
    if (mb_strlen($data['reporterName']) < 5 || !preg_match($namePattern, $data['reporterName'])) throw new InvalidArgumentException('Nombre del notificador inválido.');
    if (!preg_match('/^[A-Za-z0-9\-\/]{1,20}$/', $data['room'])) throw new InvalidArgumentException('Habitación inválida.');
    if (mb_strlen($data['drug']) < 2 || mb_strlen($data['description']) < 20 || mb_strlen($data['reporterPosition']) < 3) throw new InvalidArgumentException('Faltan datos obligatorios.');
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $data['dob']) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $data['reactionDate']) || $data['dob'] > $today || $data['reactionDate'] > $today || $data['reactionDate'] < $data['dob']) throw new InvalidArgumentException('Fechas inválidas.');
    if ($data['reactionTime'] !== '' && !preg_match('/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/', $data['reactionTime'])) throw new InvalidArgumentException('Hora inválida.');
    return $data;
}

function mapReport(array $r): array {
    return [
        'id' => $r['folio'], 'patientName' => $r['patient_name'], 'dob' => $r['patient_dob'],
        'room' => $r['room'], 'drug' => $r['suspected_drug'], 'reactionDate' => $r['reaction_date'],
        'reactionTime' => $r['reaction_time'] ? substr($r['reaction_time'], 0, 5) : '',
        'description' => $r['reaction_description'], 'reporterName' => $r['reporter_name'],
        'reporterPosition' => $r['reporter_position'],
        'timestamp' => str_replace(' ', 'T', $r['submitted_at']) . 'Z',
        'status' => $r['status_label'], 'service' => $r['service_name'] ?? '',
        'analysis' => $r['analysis'] ?? '', 'rejectionReason' => $r['rejection_reason'] ?? '',
    ];
}

function queryReports(string $where = ''): array {
    $sql = "SELECT r.*, st.label status_label, s.name service_name FROM reports r JOIN cat_report_status st ON st.id=r.status_id LEFT JOIN cat_services s ON s.id=r.service_id $where ORDER BY r.submitted_at DESC";
    return array_map('mapReport', db()->query($sql)->fetchAll());
}

function smtpRead($socket, array $expected): string {
    $response = '';
    while (($line = fgets($socket, 4096)) !== false) {
        $response .= $line;
        if (strlen($line) >= 4 && $line[3] === ' ') break;
    }
    $code = (int)substr($response, 0, 3);
    if (!in_array($code, $expected, true)) throw new RuntimeException('SMTP respondió ' . $code);
    return $response;
}

function smtpWrite($socket, string $command, array $expected): string {
    fwrite($socket, $command . "\r\n");
    return smtpRead($socket, $expected);
}

function smtpConnectAuthenticated() {
    global $config;
    $context = stream_context_create(['ssl' => ['verify_peer' => true, 'verify_peer_name' => true, 'peer_name' => $config['smtp_host']]]);
    $socket = stream_socket_client('tcp://' . $config['smtp_host'] . ':' . $config['smtp_port'], $errno, $error, 15, STREAM_CLIENT_CONNECT, $context);
    if (!$socket) throw new RuntimeException('No fue posible conectar con SMTP.');
    stream_set_timeout($socket, 20);
    try {
        smtpRead($socket, [220]);
        smtpWrite($socket, 'EHLO fvram.local', [250]);
        smtpWrite($socket, 'STARTTLS', [220]);
        if (!stream_socket_enable_crypto($socket, true, STREAM_CRYPTO_METHOD_TLS_CLIENT)) throw new RuntimeException('No fue posible activar STARTTLS.');
        smtpWrite($socket, 'EHLO fvram.local', [250]);
        $auth = base64_encode("\0{$config['smtp_user']}\0{$config['smtp_password']}");
        smtpWrite($socket, 'AUTH PLAIN ' . $auth, [235]);
        return $socket;
    } catch (Throwable $e) {
        fclose($socket);
        throw $e;
    }
}

function sendEmail(array $report): void {
    global $config;
    $socket = smtpConnectAuthenticated();
    try {
        smtpWrite($socket, 'MAIL FROM:<' . $config['smtp_user'] . '>', [250]);
        smtpWrite($socket, 'RCPT TO:<' . $config['report_email_to'] . '>', [250, 251]);
        smtpWrite($socket, 'DATA', [354]);
        $fields = [
            'Aviso' => 'Se ha creado un nuevo reporte RAM pendiente de revisión.',
            'Puesto de quien reporta' => $report['reporterPosition'],
            'Sistema' => 'Ingresa a FVRAM para consultar la información autorizada.',
        ];
        $text = '';
        foreach ($fields as $label => $value) $text .= "$label: $value\r\n";
        $subject = 'Nuevo reporte RAM pendiente de revisión';
        $message = "From: Farmacovigilancia RAM <{$config['smtp_user']}>\r\nTo: <{$config['report_email_to']}>\r\nSubject: $subject\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n" . preg_replace('/^\./m', '..', $text) . "\r\n.";
        smtpWrite($socket, $message, [250]);
        smtpWrite($socket, 'QUIT', [221]);
    } finally { fclose($socket); }
}

function processEmailQueue(int $limit = 5): void {
    global $config;
    if (empty($config['email_enabled'])) return;
    $stmt = db()->query("SELECT n.id notification_id, r.* FROM email_notifications n JOIN reports r ON r.id=n.report_id WHERE n.status='pending' AND n.next_attempt_at<=NOW() ORDER BY n.id LIMIT " . (int)$limit);
    foreach ($stmt->fetchAll() as $row) {
        $report = mapReport($row + ['status_label' => 'Pendiente', 'service_name' => '']);
        $report['folio'] = $row['folio'];
        try {
            sendEmail($report);
            $update = db()->prepare("UPDATE email_notifications SET status='sent',sent_at=NOW(),last_error=NULL WHERE id=?");
            $update->execute([$row['notification_id']]);
        } catch (Throwable $e) {
            $update = db()->prepare("UPDATE email_notifications SET attempts=attempts+1,last_error=?,next_attempt_at=DATE_ADD(NOW(),INTERVAL LEAST(60,POW(2,attempts+1)) MINUTE) WHERE id=?");
            $update->execute([mb_substr($e->getMessage(), 0, 500), $row['notification_id']]);
            error_log('FVRAM SMTP: ' . $e->getMessage());
        }
    }
}

$method = $_SERVER['REQUEST_METHOD'];
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$path = preg_replace('#^/fvram/api#', '', $path);
$path = preg_replace('#^/api#', '', $path);

try {
    if ($method === 'POST' && $path === '/internal/process-email') {
        $remote = $_SERVER['REMOTE_ADDR'] ?? '';
        $token = $_SERVER['HTTP_X_FVRAM_WORKER'] ?? '';
        if (!in_array($remote, ['127.0.0.1', '::1'], true) || !hash_equals((string)$config['worker_token'], $token)) jsonResponse(['error' => 'Acceso denegado.'], 403);
        processEmailQueue(10);
        jsonResponse(['ok' => true]);
    }
    if ($method === 'POST' && $path === '/internal/verify-smtp') {
        $remote = $_SERVER['REMOTE_ADDR'] ?? '';
        $token = $_SERVER['HTTP_X_FVRAM_WORKER'] ?? '';
        if (!in_array($remote, ['127.0.0.1', '::1'], true) || !hash_equals((string)$config['worker_token'], $token)) jsonResponse(['error' => 'Acceso denegado.'], 403);
        $socket = smtpConnectAuthenticated();
        smtpWrite($socket, 'QUIT', [221]);
        fclose($socket);
        jsonResponse(['ok' => true]);
    }
    if ($method === 'GET' && $path === '/health') {
        db()->query('SELECT 1');
        jsonResponse(['ok' => true]);
    }
    if ($method === 'POST' && $path === '/reports') {
        $data = validateReport(body());
        $pdo = db();
        $pdo->beginTransaction();
        try {
            $pdo->query("SELECT GET_LOCK('fvram_folio',10)");
            $yy = date('y'); $mm = date('m');
            $stmt = $pdo->prepare("SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(folio,'-',-1) AS UNSIGNED)),0)+1 FROM reports WHERE SUBSTRING(folio,3,2)=?");
            $stmt->execute([$yy]);
            $folio = $mm . $yy . '-' . str_pad((string)$stmt->fetchColumn(), 3, '0', STR_PAD_LEFT);
            $stmt = $pdo->prepare("INSERT INTO reports (folio,patient_name,patient_dob,room,suspected_drug,reaction_date,reaction_time,reaction_description,reporter_name,reporter_position,status_id) VALUES (?,?,?,?,?,?,?,?,?,?,1)");
            $stmt->execute([$folio,$data['patientName'],$data['dob'],$data['room'],$data['drug'],$data['reactionDate'],$data['reactionTime'] ?: null,$data['description'],$data['reporterName'],$data['reporterPosition']]);
            $id = (int)$pdo->lastInsertId();
            $pdo->prepare("INSERT INTO report_events(report_id,event_type,new_status_id,notes) VALUES (?,'created',1,'Reporte recibido desde formulario web')")->execute([$id]);
            $pdo->prepare('INSERT INTO email_notifications(report_id) VALUES (?)')->execute([$id]);
            $pdo->commit();
            $pdo->query("SELECT RELEASE_LOCK('fvram_folio')");
        } catch (Throwable $e) { $pdo->rollBack(); $pdo->query("SELECT RELEASE_LOCK('fvram_folio')"); throw $e; }
        processEmailQueue(1);
        jsonResponse(['folio' => $folio], 201);
    }
    if ($method === 'GET' && $path === '/reports/public') jsonResponse(queryReports("WHERE st.code='PUBLICADO'"));
    if ($method === 'POST' && $path === '/admin/login') {
        $password = (string)(body()['password'] ?? '');
        if (!hash_equals((string)$config['admin_password'], $password)) jsonResponse(['error' => 'Clave incorrecta.'], 401);
        session_regenerate_id(true); $_SESSION['admin'] = true; jsonResponse(['ok' => true]);
    }
    if ($method === 'POST' && $path === '/admin/logout') { requireAdmin(); $_SESSION = []; session_destroy(); jsonResponse(['ok' => true]); }
    if ($method === 'GET' && $path === '/admin/reports') { requireAdmin(); jsonResponse(queryReports()); }
    if ($method === 'POST' && $path === '/admin/import') { requireAdmin(); jsonResponse(['imported' => 0, 'skipped' => count(body()['reports'] ?? [])]); }
    if ($method === 'PUT' && preg_match('#^/admin/reports/([^/]+)$#', $path, $match)) {
        requireAdmin(); $input = body();
        $status = clean($input['status'] ?? '', 20); $service = clean($input['service'] ?? '', 80);
        $analysis = clean($input['analysis'] ?? '', 5000); $reason = clean($input['rejectionReason'] ?? '', 500);
        if (!in_array($status, ['Pendiente','Publicado','Rechazado'], true)) throw new InvalidArgumentException('Estado inválido.');
        if ($status === 'Publicado' && !$service) throw new InvalidArgumentException('Debes asignar un servicio.');
        if ($status === 'Rechazado' && mb_strlen($reason) < 8) throw new InvalidArgumentException('El motivo debe tener al menos 8 caracteres.');
        $stmt = db()->prepare("UPDATE reports r JOIN cat_report_status st ON st.label=? LEFT JOIN cat_services s ON s.name=? AND s.is_active=1 SET r.status_id=st.id,r.service_id=CASE WHEN ?='' THEN NULL ELSE s.id END,r.analysis=?,r.rejection_reason=CASE WHEN ?='Rechazado' THEN ? ELSE NULL END,r.reviewed_at=NOW() WHERE r.folio=? AND (?='' OR s.id IS NOT NULL)");
        $stmt->execute([$status,$service,$service,$analysis,$status,$reason,urldecode($match[1]),$service]);
        if (!$stmt->rowCount()) jsonResponse(['error' => 'Reporte o servicio no encontrado.'], 404);
        jsonResponse(['ok' => true]);
    }
    jsonResponse(['error' => 'Ruta no encontrada.'], 404);
} catch (InvalidArgumentException $e) { jsonResponse(['error' => $e->getMessage()], 400); }
catch (Throwable $e) { error_log('FVRAM API: ' . $e->getMessage()); jsonResponse(['error' => 'No fue posible completar la operación.'], 500); }
