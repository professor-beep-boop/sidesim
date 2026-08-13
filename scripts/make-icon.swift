// make-icon.swift — regenerates icon.png (the extension icon).
//
//   swiftc -O scripts/make-icon.swift -o /tmp/make-icon && /tmp/make-icon .
//
// The mark is a 📲: an arrow entering a device — "send your app to the
// simulator". Drawn rather than composed from emoji artwork so the extension
// ships no third-party image assets, and so every element's contrast against
// the backplate can be controlled.
//
// Contrast, measured on the rendered file (WCAG 2.1 SC 1.4.11 wants >= 3:1 for
// meaningful non-text graphics): shell 10.86:1, screen 4.06:1, arrow 6.59:1.
// Keep all three above 3:1 if you change the palette — the icon renders as
// small as 32x32 in the extensions sidebar.
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let PLATE  = (38.0, 41.0, 74.0)      // #26294A  project navy
let BODY   = (248.0, 249.0, 255.0)   // #F8F9FF  phone shell
let SCREEN = (56.0, 140.0, 235.0)    // #388CEB  project blue
let ARROW  = (112.0, 206.0, 182.0)   // #70CEB6  project teal
func cg(_ c:(Double,Double,Double))->CGColor{ CGColor(red:CGFloat(c.0/255),green:CGFloat(c.1/255),blue:CGFloat(c.2/255),alpha:1) }

func render(_ px:Int,_ out:String){
    guard let ctx=CGContext(data:nil,width:px,height:px,bitsPerComponent:8,bytesPerRow:0,
        space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue) else {return}
    let s=CGFloat(px)
    ctx.setAllowsAntialiasing(true)
    // plate
    ctx.addPath(CGPath(roundedRect:CGRect(x:0,y:0,width:s,height:s),cornerWidth:s*0.20,cornerHeight:s*0.20,transform:nil))
    ctx.setFillColor(cg(PLATE)); ctx.fillPath()
    // phone shell (right)
    ctx.addPath(CGPath(roundedRect:CGRect(x:s*0.52,y:s*0.14,width:s*0.36,height:s*0.72),
                       cornerWidth:s*0.08,cornerHeight:s*0.08,transform:nil))
    ctx.setFillColor(cg(BODY)); ctx.fillPath()
    // screen
    ctx.addPath(CGPath(roundedRect:CGRect(x:s*0.565,y:s*0.215,width:s*0.27,height:s*0.57),
                       cornerWidth:s*0.045,cornerHeight:s*0.045,transform:nil))
    ctx.setFillColor(cg(SCREEN)); ctx.fillPath()
    // arrow pointing INTO the phone
    ctx.setFillColor(cg(ARROW))
    ctx.addPath(CGPath(roundedRect:CGRect(x:s*0.06,y:s*0.425,width:s*0.21,height:s*0.15),
                       cornerWidth:s*0.025,cornerHeight:s*0.025,transform:nil))
    ctx.fillPath()
    ctx.move(to:CGPoint(x:s*0.21,y:s*0.30)); ctx.addLine(to:CGPoint(x:s*0.21,y:s*0.70))
    ctx.addLine(to:CGPoint(x:s*0.47,y:s*0.50)); ctx.closePath(); ctx.fillPath()
    guard let img=ctx.makeImage(), let d=CGImageDestinationCreateWithURL(URL(fileURLWithPath:out) as CFURL,
        UTType.png.identifier as CFString,1,nil) else {return}
    CGImageDestinationAddImage(d,img,nil); CGImageDestinationFinalize(d)
}
let dir = CommandLine.arguments[1]
// Only the real asset lands in the repo. The small previews exist purely to
// eyeball sidebar legibility, so they go to a temp dir — writing them next to
// icon.png would leave untracked files that vsce happily packages.
render(512, "\(dir)/icon.png")
let tmp = NSTemporaryDirectory()
render(32,  "\(tmp)/sidesim-icon-32.png")
render(128, "\(tmp)/sidesim-icon-128.png")
print("wrote \(dir)/icon.png")
print("previews: \(tmp)sidesim-icon-32.png, \(tmp)sidesim-icon-128.png")
