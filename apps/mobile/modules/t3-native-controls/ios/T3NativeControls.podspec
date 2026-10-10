Pod::Spec.new do |s|
  s.name           = 'T3NativeControls'
  s.version        = '1.0.0'
  s.summary        = 'Native UIKit controls for T3 Code mobile.'
  s.description    = 'UIKit-backed controls that match native iOS navigation chrome.'
  s.author         = 'T3 Tools'
  s.homepage       = 'https://t3tools.com'
  s.platforms      = {
    :ios => '18.0',
  }
  s.source         = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # Swift 6.4 also ships with the iOS 27.0 SDK, which lacks the hinge APIs.
  # Gate their compilation on the SDK; Swift still checks runtime availability.
  ios_sdk_version = Pod::Executable.execute_command('xcrun', ['--sdk', 'iphoneos', '--show-sdk-version']).strip
  layout_conditions = '$(inherited)'
  if Gem::Version.new(ios_sdk_version) >= Gem::Version.new('27.1')
    layout_conditions += ' T3_HAS_HINGE_SDK'
  end
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_ACTIVE_COMPILATION_CONDITIONS' => layout_conditions,
  }
  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
end
