<?php
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if (str_starts_with($path, '/api/') || $path === '/api' || str_starts_with($path, '/fvram/api/')) {
    require __DIR__ . '/index.php';
    return true;
}
return false;
